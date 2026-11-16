import type { BFChar, Token } from './types';

const LANG = new Set<string>(['<', '>', '+', '-', '.', ',', '[', ']']);

const isBF = (c: string): c is BFChar => LANG.has(c);

export class Lexer {
  private i = 0;
  private line = 1;
  private col = 1;
  private peeked: Token | null = null;

  constructor(private readonly src: string) {}

  peek(): Token | null {
    if (this.peeked === null) this.peeked = this.nextTokenInternal();
    return this.peeked;
  }

  nextToken(): Token | null {
    if (this.peeked !== null) {
      const t = this.peeked;
      this.peeked = null;
      return t;
    }
    return this.nextTokenInternal();
  }

  private nextTokenInternal(): Token | null {
    const { src } = this;
    const n = src.length;

    while (this.i < n) {
      const index = this.i++;
      const ch = src[index]!;
      const line = this.line;
      const column = this.col;

      if (ch === '\n') {
        this.line += 1;
        this.col = 1;
      } else {
        this.col += 1;
      }

      if (isBF(ch)) {
        return { ch, loc: { line, column, index } };
      }
    }
    return null;
  }
}
