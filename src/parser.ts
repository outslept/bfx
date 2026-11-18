import { Lexer } from "./lexer.ts";
import { Op, type BFChar, type Program, type Token } from "./types.ts";

interface Instruction {
  op: Op;
  a: number;
  b: number;
}

function wrapSignedByte(n: number): number {
  const mod = ((n % 256) + 256) % 256;
  return mod <= 127 ? mod : mod - 256;
}

export class Parser {
  private flat: Instruction[] = [];
  private forwardStack: Array<{ index: number; loc: { line: number; column: number } }> = [];

  parse(lexer: Lexer): Program {
    this.flat = [];
    this.forwardStack = [];

    while (true) {
      const t = lexer.nextToken();
      if (!t) break;
      this.emitFromToken(lexer, t);
    }

    if (this.forwardStack.length > 0) {
      const u = this.forwardStack[this.forwardStack.length - 1]!;
      throw new Error(`Unmatched '[' at ${u.loc.line}:${u.loc.column}`);
    }

    return this.assemble(this.optimize(this.flat));
  }

  private countMore(lexer: Lexer, ch: BFChar): number {
    let count = 0;
    while (lexer.peek()?.ch === ch) {
      lexer.nextToken();
      count += 1;
    }
    return count;
  }

  private emitFromToken(lexer: Lexer, token: Token): void {
    switch (token.ch) {
      case ">": {
        this.flat.push({ op: Op.Move, a: 1 + this.countMore(lexer, ">"), b: 0 });
        break;
      }
      case "<": {
        this.flat.push({ op: Op.Move, a: -(1 + this.countMore(lexer, "<")), b: 0 });
        break;
      }
      case "+": {
        const n = 1 + this.countMore(lexer, "+");
        if (n % 256 !== 0) this.flat.push({ op: Op.Add, a: n, b: 0 });
        break;
      }
      case "-": {
        const n = 1 + this.countMore(lexer, "-");
        if (n % 256 !== 0) this.flat.push({ op: Op.Add, a: -n, b: 0 });
        break;
      }
      case ".": {
        this.flat.push({ op: Op.Out, a: 1 + this.countMore(lexer, "."), b: 0 });
        break;
      }
      case ",": {
        this.flat.push({ op: Op.In, a: 1 + this.countMore(lexer, ","), b: 0 });
        break;
      }
      case "[": {
        this.forwardStack.push({ index: this.flat.length, loc: token.loc });
        this.flat.push({ op: Op.JmpF, a: 0, b: 0 });
        break;
      }
      case "]": {
        const top = this.forwardStack.pop();
        if (!top) throw new Error(`Unmatched ']' at ${token.loc.line}:${token.loc.column}`);
        this.flat[top.index]!.a = this.flat.length;
        this.flat.push({ op: Op.JmpB, a: top.index + 1, b: 0 });
        break;
      }
    }
  }

  private optimize(input: Instruction[]): Instruction[] {
    const out: Instruction[] = [];
    const loopStack: number[] = [];

    for (let i = 0; i < input.length; i++) {
      const ins = input[i]!;

      if (ins.op === Op.JmpF) {
        const j = ins.a;
        const closer = input[j];
        if (!closer || closer.op !== Op.JmpB) throw new Error("Invalid jump structure");

        if (this.tryScan(input, out, i, j) || this.tryMulLoop(input, out, i, j)) {
          i = j;
          continue;
        }

        loopStack.push(out.length);
        out.push({ op: Op.JmpF, a: 0, b: 0 });
        continue;
      }

      if (ins.op === Op.JmpB) {
        const start = loopStack.pop();
        if (start === undefined) throw new Error("Unbalanced loops during optimize");
        out[start]!.a = out.length;
        out.push({ op: Op.JmpB, a: start + 1, b: 0 });
        continue;
      }

      this.pushMerged(out, ins);
    }

    if (loopStack.length > 0) throw new Error("Unbalanced loops after optimize");
    return out;
  }

  private pushMerged(out: Instruction[], inst: Instruction): void {
    const prev = out.length > 0 ? out[out.length - 1] : undefined;
    if (!prev) {
      out.push(inst);
      return;
    }

    if (inst.op === Op.Move && prev.op === Op.Move) {
      const net = prev.a + inst.a;
      if (net === 0) out.pop();
      else prev.a = net;
      return;
    }

    if (inst.op === Op.Add && prev.op === Op.Add) {
      const net = wrapSignedByte(prev.a + inst.a);
      if (net === 0) out.pop();
      else prev.a = net;
      return;
    }

    if ((inst.op === Op.Out && prev.op === Op.Out) || (inst.op === Op.In && prev.op === Op.In)) {
      prev.a += inst.a;
      return;
    }

    if (
      inst.op === Op.Clear &&
      (prev.op === Op.Add || prev.op === Op.Set || prev.op === Op.Clear)
    ) {
      prev.op = Op.Clear;
      prev.a = 0;
      return;
    }

    if (inst.op === Op.Add && prev.op === Op.Clear) {
      prev.op = Op.Set;
      prev.a = wrapSignedByte(inst.a);
      return;
    }

    if (inst.op === Op.Add && prev.op === Op.Set) {
      prev.a = wrapSignedByte(prev.a + inst.a);
      return;
    }

    out.push(inst);
  }

  private tryScan(input: Instruction[], out: Instruction[], i: number, j: number): boolean {
    if (j - i - 1 !== 1) return false;
    const body = input[i + 1]!;
    if (body.op !== Op.Move || Math.abs(body.a) !== 1) return false;

    out.push({ op: body.a === 1 ? Op.ScanR : Op.ScanL, a: 0, b: 0 });
    return true;
  }

  private tryMulLoop(input: Instruction[], out: Instruction[], i: number, j: number): boolean {
    if (j - i - 1 < 1) return false;

    const first = input[i + 1]!;
    if (first.op !== Op.Add || Math.abs(first.a) !== 1) return false;

    let ptr = 0;
    const factors = new Map<number, number>();

    for (let k = i + 2; k < j; k++) {
      const ins = input[k]!;
      if (ins.op === Op.Move) {
        ptr += ins.a;
      } else if (ins.op === Op.Add) {
        if (ptr === 0) return false;
        factors.set(ptr, (factors.get(ptr) ?? 0) + ins.a);
      } else {
        return false;
      }
    }

    if (ptr !== 0) return false;

    for (const [offset, factor] of factors) {
      out.push({ op: Op.MulAdd, a: offset, b: factor });
    }
    this.pushMerged(out, { op: Op.Clear, a: 0, b: 0 });
    return true;
  }

  private assemble(insts: Instruction[]): Program {
    const n = insts.length;
    const op = new Int32Array(n);
    const a = new Int32Array(n);
    const b = new Int32Array(n);

    for (let i = 0; i < n; i++) {
      const ins = insts[i]!;
      op[i] = ins.op;
      a[i] = ins.a;
      b[i] = ins.b;
    }

    return { op, a, b, length: n };
  }
}
