# bfx

minimal brainfuck toolchain written in typescript.

includes a lexer, optimizing parser, bytecode interpreter, and cli.

## features

- brainfuck lexer and optimizing parser
- typed-array bytecode representation
- peephole and loop optimizations (`clear`, `set`, `muladd`, `scanl`, `scanr`)
- dynamically growing 8-bit tape
- configurable step and memory limits
- byte-oriented i/o
- cli support for files and stdin

## usage

run a file:

```bash
bfx hello.bf
```

read source from stdin:

```bash
echo '++++++++[>++++++++<-]>+.' | bfx -
```

options:

```text
-h, --help       show help for the command
    --no-color   disable color output
-v, --version    print the cli version
```

## api

```ts
import { Lexer, Parser, Interpreter } from 'bfx';

const lexer = new Lexer('++++++++[>++++++++<-]>+.');
const parser = new Parser();
const program = parser.parse(lexer);

const interpreter = new Interpreter(program);
const output = interpreter.run();
```

configure input and runtime limits:

```ts
const interpreter = new Interpreter(program, {
  input: 'hello',
  tapeSize: 65536,
  maxTapeSize: 1_000_000,
  maxSteps: 10_000_000,
});
```

## brainfuck

supported instructions:

```text
>  move right
<  move left
+  increment
-  decrement
.  output
,  input
[  loop start
]  loop end
```

all other characters are ignored.
