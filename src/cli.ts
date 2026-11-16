#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { parseArgs, styleText } from 'node:util';
import { Interpreter, Lexer, Parser } from './index';

const VERSION = '1.0.0';
const MAX_SOURCE_SIZE = 10 * 1024 * 1024; // 10 MB

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const KNOWN_OPTIONS = ['--help', '--no-color', '--version'] as const;

const BYTE_CHUNKS: readonly Buffer[] = Array.from({ length: 256 }, (_, i) => Buffer.from([i]));

interface StreamMode {
  rich: boolean;
  color: boolean;
}

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly details: Array<[label: string, value: string]> = [],
    readonly recovery?: { label: string; command: string },
  ) {
    super(message);
  }
}

function resolveStreamMode(
  stream: NodeJS.WriteStream,
  noColorOpt: boolean,
  env: NodeJS.ProcessEnv = process.env,
): StreamMode {
  const rich = Boolean(stream.isTTY && env.TERM !== 'dumb' && !env.VERCEL_ACCESSIBLE);
  if (noColorOpt || env.NO_COLOR) return { rich, color: false };
  if (env.FORCE_COLOR !== undefined) {
    return { rich, color: env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== '' };
  }
  return { rich, color: rich };
}

function sanitizeText(input: string): string {
  return input.replace(
    // Strip ANSI CSI/OSC sequences, C0/C1 controls, and zero-width / bidi format characters.
    /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
    '',
  );
}

function suggestOption(unknown: string): string | undefined {
  if (!unknown.startsWith('-')) return undefined;
  const norm = unknown.replace(/^-+/, '').toLowerCase();
  if (!norm) return undefined;
  return KNOWN_OPTIONS.find((opt) => {
    const target = opt.slice(2);
    return target.startsWith(norm) || norm.startsWith(target);
  });
}

function showHelp(noColorOpt: boolean): void {
  const mode = resolveStreamMode(process.stdout, noColorOpt);
  const styled = mode.rich && mode.color;
  const bold = (s: string): string => (styled ? styleText('bold', s) : s);
  const dim = (s: string): string => (styled ? styleText('dim', s) : s);
  const heading = (s: string): string => (styled ? styleText(['bold', 'magenta'], s) : s);
  const cmd = (s: string): string => (styled ? styleText('cyan', s) : s);

  const help = `${bold('bf-ts')} <file> [options]
${dim('Execute a Brainfuck program from a file or stdin')}

${heading('Arguments:')}
  <file>           Path to a Brainfuck source file, or - for stdin

${heading('Options:')}
  ${bold('-h, --help')}       Show help for the command
  ${bold('--no-color')}       Disable color output
  ${bold('-v, --version')}    Print the CLI version

${heading('Examples:')}
  Execute a Brainfuck file
    ${cmd('bf-ts hello.bf')}

  Execute a program from stdin
    ${cmd('bf-ts -')}

${heading('Notes:')}
  Source input is UTF-8 text up to 10 MB. Program output is written as raw bytes to stdout.
`;
  process.stdout.write(help);
}

function printError(err: CliError, noColorOpt: boolean): void {
  const { rich, color } = resolveStreamMode(process.stderr, noColorOpt);
  const safeMessage = sanitizeText(err.message);
  const lines: string[] = [];

  if (rich) {
    const glyph = color ? styleText('red', '✗') : '✗';
    const headline = color ? styleText('bold', safeMessage) : safeMessage;
    lines.push(`${glyph} ${headline}`);
  } else {
    const prefix = color ? styleText('red', 'Error:') : 'Error:';
    lines.push(`${prefix} ${safeMessage}`);
  }

  for (const [label, value] of err.details) {
    lines.push(`  ${label.padEnd(16)}${sanitizeText(value)}`);
  }

  if (err.recovery) {
    const recCmd = rich && color ? styleText('cyan', err.recovery.command) : err.recovery.command;
    lines.push('', `  ${err.recovery.label}:`, `    ${recCmd}`);
  }

  process.stderr.write(`${lines.join('\n')}\n`);
}

function parseCliArgs(args: string[]): {
  help: boolean;
  version: boolean;
  noColor: boolean;
  sourceFile: string;
} {
  const parsed = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      'no-color': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
    },
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  let help = false;
  let version = false;
  let noColor = false;
  let unknownOption: string | undefined;

  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (token.name === 'help') help = true;
    else if (token.name === 'version') version = true;
    else if (token.name === 'no-color') noColor = true;
    else if (
      token.name.startsWith('no-') &&
      (token.name === 'no-help' || token.name === 'no-version')
    ) {
      unknownOption ??= token.rawName;
    } else if (typeof parsed.values[token.name] !== 'boolean') {
      unknownOption ??= token.rawName;
    } else {
      unknownOption ??= token.rawName;
    }
  }

  if (help || (parsed.positionals[0] === 'help' && !unknownOption)) {
    return { help: true, version: false, noColor, sourceFile: '' };
  }

  if (unknownOption) {
    const suggestion = suggestOption(unknownOption);
    const hint = suggestion ? ` Did you mean ${suggestion}?` : '';
    throw new CliError(`Unknown option ${unknownOption} for bf-ts.${hint}`, EXIT_USAGE, [], {
      label: 'See all options',
      command: 'bf-ts --help',
    });
  }

  if (version) {
    return { help: false, version: true, noColor, sourceFile: '' };
  }

  if (parsed.positionals.length === 0) {
    throw new CliError("Can't execute without a file argument.", EXIT_USAGE, [], {
      label: 'Pass a file or read from stdin',
      command: 'bf-ts <FILE>',
    });
  }

  if (parsed.positionals.length > 1) {
    throw new CliError(
      `Can't execute bf-ts. Expected 1 file argument, got ${parsed.positionals.length}.`,
      EXIT_USAGE,
      [],
      { label: 'See usage', command: 'bf-ts --help' },
    );
  }

  return { help: false, version: false, noColor, sourceFile: parsed.positionals[0]! };
}

function readSource(sourceFile: string): string {
  if (sourceFile === '-') {
    if (process.stdin.isTTY) {
      throw new CliError("Can't read from stdin without piped input.", EXIT_USAGE, [], {
        label: 'Pipe a program to stdin',
        command: 'bf-ts -',
      });
    }
    const buf = readFileSync(0);
    if (buf.byteLength > MAX_SOURCE_SIZE) {
      throw new CliError("Can't read stdin. Source exceeds the 10 MB limit.", EXIT_ERROR, [
        ['Limit', '10 MB'],
      ]);
    }
    return buf.toString('utf8');
  }

  const stat = statSync(sourceFile, { throwIfNoEntry: false });
  if (!stat) {
    throw new CliError(`Couldn't find file ${sourceFile}.`, EXIT_ERROR, [], {
      label: 'Check the file path, then run',
      command: 'bf-ts <FILE>',
    });
  }
  if (stat.isDirectory()) {
    throw new CliError(
      `Can't execute ${sourceFile}. Path is a directory, not a file.`,
      EXIT_ERROR,
      [],
      { label: 'Pass a Brainfuck source file', command: 'bf-ts <FILE>' },
    );
  }
  if (stat.size > MAX_SOURCE_SIZE) {
    throw new CliError(`Can't read ${sourceFile}. Source exceeds the 10 MB limit.`, EXIT_ERROR, [
      ['Limit', '10 MB'],
    ]);
  }

  return readFileSync(sourceFile, 'utf8');
}

function formatRuntimeError(error: unknown, sourceFile: string): CliError {
  const raw = error instanceof Error ? error.message : String(error);
  const label = sourceFile === '-' ? 'stdin' : sourceFile || 'program';

  const syntaxMatch = /^Unmatched '(\[|\])' at (\d+):(\d+)$/.exec(raw);
  if (syntaxMatch) {
    const [, bracket, line, col] = syntaxMatch;
    return new CliError(`${label}:${line}:${col} Unmatched "${bracket}".`, EXIT_ERROR);
  }

  return new CliError(
    `Failed to execute ${label}. ${raw}.`,
    EXIT_ERROR,
    sourceFile && sourceFile !== '-' ? [['File', sourceFile]] : [],
  );
}

function isBrokenPipe(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPIPE';
}

export function main(argv: string[] = process.argv.slice(2)): void {
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(EXIT_OK);
    throw err;
  });

  process.on('SIGINT', () => process.exit(130));
  process.on('SIGHUP', () => process.exit(129));
  process.on('SIGTERM', () => process.exit(143));

  let noColor = argv.includes('--no-color');
  let sourceFile = '';

  try {
    const parsed = parseCliArgs(argv);
    noColor = parsed.noColor;

    if (parsed.help) {
      showHelp(noColor);
      process.exit(EXIT_OK);
    }

    if (parsed.version) {
      process.stdout.write(`${VERSION}\n`);
      process.exit(EXIT_OK);
    }

    sourceFile = parsed.sourceFile;
    const sourceCode = readSource(sourceFile);
    const program = new Parser().parse(new Lexer(sourceCode));

    const interpreter = new Interpreter(program, {
      onOutputByte: (byte: number) => {
        process.stdout.write(BYTE_CHUNKS[byte & 0xff]!);
      },
      onOutputBurst: (byte: number, count: number) => {
        process.stdout.write(Buffer.alloc(count, byte));
      },
    });

    interpreter.run();
  } catch (error) {
    if (isBrokenPipe(error)) {
      process.exit(EXIT_OK);
    }
    const cliError = error instanceof CliError ? error : formatRuntimeError(error, sourceFile);
    printError(cliError, noColor);
    process.exit(cliError.exitCode);
  }
}

if (require.main === module) {
  main();
}
