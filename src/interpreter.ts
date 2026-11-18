import { Op, type Program } from "./types";

const DEFAULT_TAPE_SIZE = 65536;
const BURST_THRESHOLD = 8;
const BYTE_MASK = 0xff;

export interface RuntimeOptions {
  tapeSize?: number;
  grow?: boolean;
  maxTapeSize?: number;
  input?: Uint8Array | string;
  maxSteps?: number;
  onOutputByte?: (byte: number) => void;
  onOutputBurst?: (byte: number, count: number) => void;
}

const textEncoder = new TextEncoder();

export class Interpreter {
  private memory: Uint8Array;
  private ptr = 0;
  private ip = 0;
  private readonly input: Uint8Array;
  private inputIndex = 0;
  private readonly grow: boolean;
  private readonly maxTapeSize: number | undefined;
  private readonly maxSteps: number | undefined;
  private readonly onOutputByte: ((byte: number) => void) | undefined;
  private readonly onOutputBurst: ((byte: number, count: number) => void) | undefined;

  constructor(
    private readonly program: Program,
    opts: RuntimeOptions = {},
  ) {
    const initial = Math.max(1, opts.tapeSize ?? DEFAULT_TAPE_SIZE);
    this.memory = new Uint8Array(initial);
    this.grow = opts.grow ?? true;
    this.maxTapeSize = opts.maxTapeSize;
    this.maxSteps = opts.maxSteps;
    this.onOutputByte = opts.onOutputByte;
    this.onOutputBurst = opts.onOutputBurst;

    if (opts.input instanceof Uint8Array) {
      this.input = opts.input;
    } else if (typeof opts.input === "string") {
      this.input = textEncoder.encode(opts.input);
    } else {
      this.input = new Uint8Array(0);
    }
  }

  run(): Uint8Array {
    const { op, a, b, length: progLen } = this.program;
    const {
      grow,
      maxTapeSize,
      maxSteps,
      input,
      onOutputByte: onOut,
      onOutputBurst: onBurst,
    } = this;

    let mem = this.memory;
    let ptr = this.ptr;
    let ip = this.ip;
    let inputIndex = this.inputIndex;
    let steps = 0;

    let collected = new Uint8Array(1024);
    let collectedLen = 0;

    const emit = (byte: number): void => {
      if (onOut) {
        onOut(byte & BYTE_MASK);
        return;
      }
      if (collectedLen >= collected.length) {
        const next = new Uint8Array(collected.length * 2);
        next.set(collected);
        collected = next;
      }
      collected[collectedLen++] = byte & BYTE_MASK;
    };

    const ensureCapacity = (index: number): void => {
      if (index < mem.length) return;
      if (!grow) throw new Error(`Tape overflow at cell ${index}`);

      let newLen = mem.length;
      while (newLen <= index) newLen *= 2;

      if (maxTapeSize !== undefined) {
        if (index >= maxTapeSize) {
          throw new Error(`Tape size exceeded hard cap: ${maxTapeSize}`);
        }
        if (newLen > maxTapeSize) {
          newLen = maxTapeSize;
        }
      }

      const next = new Uint8Array(newLen);
      next.set(mem);
      mem = next;
      this.memory = mem;
    };

    while (ip < progLen) {
      if (maxSteps !== undefined) {
        if (steps >= maxSteps) throw new Error(`Step limit exceeded: ${maxSteps}`);
        steps += 1;
      }

      const code = op[ip] as Op;
      const arg = a[ip] | 0;

      switch (code) {
        case Op.Move: {
          const nxt = ptr + arg;
          if (nxt < 0) throw new Error("Pointer moved left of tape");
          ensureCapacity(nxt);
          ptr = nxt;
          ip += 1;
          break;
        }
        case Op.Add: {
          mem[ptr] = (mem[ptr]! + arg) & BYTE_MASK;
          ip += 1;
          break;
        }
        case Op.Clear: {
          mem[ptr] = 0;
          ip += 1;
          break;
        }
        case Op.Set: {
          mem[ptr] = arg & BYTE_MASK;
          ip += 1;
          break;
        }
        case Op.MulAdd: {
          const dest = ptr + arg;
          if (dest < 0) throw new Error("Pointer moved left of tape");
          ensureCapacity(dest);
          const v = mem[ptr]!;
          if (v !== 0) {
            const factor = b[ip] | 0;
            mem[dest] = (mem[dest]! + v * factor) & BYTE_MASK;
          }
          ip += 1;
          break;
        }
        case Op.ScanR: {
          while (mem[ptr] !== 0) {
            ptr += 1;
            ensureCapacity(ptr);
          }
          ip += 1;
          break;
        }
        case Op.ScanL: {
          while (mem[ptr] !== 0) {
            if (ptr === 0) throw new Error("Pointer moved left of tape");
            ptr -= 1;
          }
          ip += 1;
          break;
        }
        case Op.Out: {
          const count = arg >>> 0;
          const val = mem[ptr]!;
          if (onBurst && count > BURST_THRESHOLD) {
            onBurst(val, count);
          } else {
            for (let k = 0; k < count; k++) emit(val);
          }
          ip += 1;
          break;
        }
        case Op.In: {
          const count = arg >>> 0;
          for (let k = 0; k < count; k++) {
            mem[ptr] = inputIndex < input.length ? input[inputIndex++]! : 0;
          }
          ip += 1;
          break;
        }
        case Op.JmpF: {
          ip = mem[ptr] === 0 ? arg : ip + 1;
          break;
        }
        case Op.JmpB: {
          ip = mem[ptr] !== 0 ? arg : ip + 1;
          break;
        }
        default: {
          throw new Error(`Unknown opcode ${code} at ip=${ip}`);
        }
      }
    }

    this.ptr = ptr;
    this.ip = ip;
    this.inputIndex = inputIndex;
    this.memory = mem;
    return collected.subarray(0, collectedLen);
  }
}
