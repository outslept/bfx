import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Interpreter, Lexer, Op, Parser, type RuntimeOptions } from "../src/index";

function compile(src: string) {
  return new Parser().parse(new Lexer(src));
}

function exec(src: string, opts?: RuntimeOptions): Uint8Array {
  return new Interpreter(compile(src), opts).run();
}

function runCli(args: string[], input?: string) {
  const cliPath = join(import.meta.dirname, "../dist/cli.js");
  return spawnSync(process.execPath, [cliPath, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

test("lexer tracks line, column, index and peek state", () => {
  const lexer = new Lexer("a+\n >");
  expect(lexer.peek()).toEqual({ ch: "+", loc: { line: 1, column: 2, index: 1 } });
  expect(lexer.nextToken()).toEqual({ ch: "+", loc: { line: 1, column: 2, index: 1 } });
  expect(lexer.nextToken()).toEqual({ ch: ">", loc: { line: 2, column: 2, index: 4 } });
  expect(lexer.nextToken()).toBeNull();
});

test("parser optimizes clear, set, mul-add, scan and cancelling ops", () => {
  const cancelled = compile(`>${"+".repeat(256)}<`);
  expect(cancelled.length).toBe(0);

  const setProg = compile("+++[-]++---");
  expect([...setProg.op]).toEqual([Op.Set]);
  expect([...setProg.a]).toEqual([-1]);

  const scanProg = compile("[>][<]");
  expect([...scanProg.op]).toEqual([Op.ScanR, Op.ScanL]);

  const mulProg = compile("[->+++<<+>]");
  expect([...mulProg.op]).toEqual([Op.MulAdd, Op.MulAdd, Op.Clear]);
  expect([...mulProg.a]).toEqual([1, -1, 0]);
  expect([...mulProg.b]).toEqual([3, 1, 0]);
});

test("parser reports unmatched brackets with coordinates", () => {
  expect(() => compile("+\n  ]")).toThrow(/Unmatched '\]' at 2:3/);
  expect(() => compile("[\n+")).toThrow(/Unmatched '\[' at 1:1/);
});

test("interpreter executes arithmetic, loops, scans, IO and tape growth", () => {
  expect(exec("++++++++[>++++++++<-]>+.")).toEqual(new Uint8Array([65]));
  expect(exec(">+>+[<]>+.")).toEqual(new Uint8Array([2]));
  expect(exec(",.,.,.", { input: "ab" })).toEqual(new Uint8Array([97, 98, 0]));
  expect(exec(",.", { input: new Uint8Array([255]) })).toEqual(new Uint8Array([255]));

  const largeOut = exec(`+${".".repeat(1100)}`);
  expect(largeOut.length).toBe(1100);
  expect(largeOut[1099]).toBe(1);

  const events: Array<[string, number, number]> = [];
  exec(`+++..${"[-]++++..... ....."}`, {
    onOutputByte: (b) => events.push(["byte", b, 1]),
    onOutputBurst: (b, c) => events.push(["burst", b, c]),
  });
  expect(events).toEqual([
    ["byte", 3, 1],
    ["byte", 3, 1],
    ["burst", 4, 10],
  ]);
});

test("interpreter enforces tape bounds, step limits and valid opcodes", () => {
  expect(() => exec("<")).toThrow(/Pointer moved left of tape/);
  expect(() => exec("+[->+<]<[<]")).toThrow(/Pointer moved left of tape/);
  expect(() => exec("+[-<+>]")).toThrow(/Pointer moved left of tape/);
  expect(() => exec(">>", { tapeSize: 2, grow: false })).toThrow(/Tape overflow at cell 2/);
  expect(() => exec(">>>>", { tapeSize: 2, maxTapeSize: 4 })).toThrow(
    /Tape size exceeded hard cap: 4/,
  );
  expect(exec(">>+.", { tapeSize: 2, maxTapeSize: 3 })).toEqual(new Uint8Array([1]));
  expect(() => exec("+[>.<]", { maxSteps: 3 })).toThrow(/Step limit exceeded: 3/);
  expect(() =>
    new Interpreter({
      op: new Int32Array([99]),
      a: new Int32Array([0]),
      b: new Int32Array([0]),
      length: 1,
    }).run(),
  ).toThrow(/Unknown opcode 99 at ip=0/);
});

test("cli handles flags, files, stdin and error exit codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "bfx-"));
  try {
    const file = join(dir, "prog.bf");
    const badFile = join(dir, "bad.bf");
    writeFileSync(file, `${"+".repeat(66)}.`);
    writeFileSync(badFile, "[");

    const ver = runCli(["--version"]);
    expect(ver.status).toBe(0);
    expect(ver.stdout).toBe("1.0.0\n");

    const help = runCli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/Execute a Brainfuck program/);

    const okFile = runCli([file]);
    expect(okFile.status).toBe(0);
    expect(okFile.stdout).toBe("B");

    const okStdin = runCli(["-"], `${"+".repeat(67)}.`);
    expect(okStdin.status).toBe(0);
    expect(okStdin.stdout).toBe("C");

    const badOpt = runCli(["--ver"]);
    expect(badOpt.status).toBe(2);
    expect(badOpt.stderr).toMatch(/Did you mean --version\?/);

    const noArgs = runCli([]);
    expect(noArgs.status).toBe(2);
    expect(noArgs.stderr).toMatch(/without a file argument/);

    const twoArgs = runCli([file, file]);
    expect(twoArgs.status).toBe(2);
    expect(twoArgs.stderr).toMatch(/Expected 1 file argument, got 2/);

    const missing = runCli([join(dir, "nope.bf")]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/Couldn't find file/);

    const isDir = runCli([dir]);
    expect(isDir.status).toBe(1);
    expect(isDir.stderr).toMatch(/Path is a directory/);

    const syntax = runCli([badFile]);
    expect(syntax.status).toBe(1);
    expect(syntax.stderr).toMatch(/bad\.bf:1:1 Unmatched "\["\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixtures compile and self-checking programs pass", () => {
  const fixturesDir = join(import.meta.dirname, "../fixtures");
  for (const name of readdirSync(fixturesDir)) {
    const src = readFileSync(join(fixturesDir, name), "utf8");
    expect(() => compile(src), name).not.toThrow();
  }

  for (const quine of ["392quine.b", "400quine.b", "dquine.b"]) {
    const src = readFileSync(join(fixturesDir, quine), "utf8");
    const out = new TextDecoder().decode(exec(src));
    expect(src.replace(/\s+/g, "")).toContain(out.replace(/\s+/g, ""));
    expect(new TextDecoder().decode(exec(out)), quine).toBe(out);
  }
});
