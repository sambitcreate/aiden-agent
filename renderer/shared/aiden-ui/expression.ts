import type { AidenUiActionV1, AidenUiExprV1, AidenUiFunctionName } from "./types.js";

/**
 * Parses an AUM `{…}` source into the expression data AST, or a top-level
 * action call. The grammar is deliberately small (see the spec §5.1): there
 * are no assignments, loops, arrow functions, or arithmetic beyond `+`.
 */

const FUNCTIONS = new Set<AidenUiFunctionName>(["fmt", "len", "sum", "max", "min", "round", "filter", "sort"]);
const ACTIONS = new Set(["sendPrompt", "setState", "openUrl", "copy"]);
const MAX_SOURCE_CHARS = 16_384;

type Token =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "ident"; value: string }
  | { type: "var"; value: string }
  | { type: "punct"; value: string };

class ExpressionError extends Error {}

const PUNCTUATION = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "=>", "<", ">", "+", "-", "!", "?", ":", ".", ",", "(", ")", "[", "]", "{", "}", "=", "*", "/", "%"];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let value = "";
      let cursor = index + 1;
      let closed = false;
      while (cursor < source.length) {
        const inner = source[cursor]!;
        if (inner === "\\" && cursor + 1 < source.length) {
          const escaped = source[cursor + 1]!;
          value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
          cursor += 2;
          continue;
        }
        if (inner === char) {
          closed = true;
          break;
        }
        value += inner;
        cursor += 1;
      }
      if (!closed) throw new ExpressionError("Unterminated string");
      tokens.push({ type: "str", value });
      index = cursor + 1;
      continue;
    }
    if (/[0-9]/u.test(char) || (char === "." && /[0-9]/u.test(source[index + 1] ?? ""))) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(source.slice(index))!;
      tokens.push({ type: "num", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (char === "$") {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(index));
      if (!match) throw new ExpressionError("Expected a name after $");
      tokens.push({ type: "var", value: match[0].slice(1) });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(index))!;
      tokens.push({ type: "ident", value: match[0] });
      index += match[0].length;
      continue;
    }
    const punct = PUNCTUATION.find((candidate) => source.startsWith(candidate, index));
    if (!punct) throw new ExpressionError(`Unexpected "${char}"`);
    tokens.push({ type: "punct", value: punct });
    index += punct.length;
  }
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token?.type === "punct" && token.value === value;
  }

  private expect(value: string): void {
    if (!this.isPunct(value)) throw new ExpressionError(`Expected "${value}"`);
    this.index += 1;
  }

  done(): boolean {
    return this.index >= this.tokens.length;
  }

  /** A top-level action call, if the whole source is one. */
  action(): AidenUiActionV1 | undefined {
    const token = this.peek();
    if (token?.type !== "ident" || !ACTIONS.has(token.value)) return undefined;
    const next = this.tokens[this.index + 1];
    if (next?.type !== "punct" || next.value !== "(") return undefined;
    this.index += 2;
    const args = this.args();
    switch (token.value) {
      case "sendPrompt":
        if (args.length !== 1) throw new ExpressionError("sendPrompt takes one argument");
        return { act: "send", text: args[0]! };
      case "copy":
        if (args.length !== 1) throw new ExpressionError("copy takes one argument");
        return { act: "copy", text: args[0]! };
      case "openUrl":
        if (args.length !== 1) throw new ExpressionError("openUrl takes one argument");
        return { act: "open", url: args[0]! };
      default: {
        const key = args[0];
        if (args.length !== 2 || key?.op !== "lit" || typeof key.v !== "string" || !key.v) {
          throw new ExpressionError('setState needs a string key and a value: setState("key", value)');
        }
        return { act: "set", key: key.v, value: args[1]! };
      }
    }
  }

  expression(): AidenUiExprV1 {
    const test = this.binary(0);
    if (!this.isPunct("?")) return test;
    this.index += 1;
    const then = this.expression();
    this.expect(":");
    const otherwise = this.expression();
    return { op: "if", test, then, else: otherwise };
  }

  private static readonly LEVELS: readonly (readonly string[])[] = [
    ["||"],
    ["&&"],
    ["==", "!=", "===", "!=="],
    ["<", "<=", ">", ">="],
    ["+"],
  ];

  private binary(level: number): AidenUiExprV1 {
    if (level >= Parser.LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    while (true) {
      const token = this.peek();
      if (token?.type !== "punct") return left;
      if (token.value === "-" || token.value === "*" || token.value === "/" || token.value === "%") {
        throw new ExpressionError(`"${token.value}" is not supported; use + or a function like sum() or round()`);
      }
      if (token.value === "=" || token.value === "=>") {
        throw new ExpressionError("Assignments and arrow functions are not supported");
      }
      if (!Parser.LEVELS[level]!.includes(token.value)) return left;
      this.index += 1;
      const right = this.binary(level + 1);
      const operator = token.value === "===" ? "==" : token.value === "!==" ? "!=" : token.value;
      left = { op: "bin", o: operator as "+", l: left, r: right };
    }
  }

  private unary(): AidenUiExprV1 {
    if (this.isPunct("!")) {
      this.index += 1;
      return { op: "not", e: this.unary() };
    }
    if (this.isPunct("-") || this.isPunct("+")) {
      const negative = this.isPunct("-");
      this.index += 1;
      const token = this.peek();
      if (token?.type !== "num") throw new ExpressionError("A sign must precede a number");
      this.index += 1;
      return { op: "lit", v: negative ? -token.value : token.value };
    }
    return this.postfix(this.primary());
  }

  private postfix(base: AidenUiExprV1): AidenUiExprV1 {
    let node = base;
    while (true) {
      if (this.isPunct(".")) {
        this.index += 1;
        const name = this.peek();
        if (name?.type !== "ident") throw new ExpressionError("Expected a property name after .");
        this.index += 1;
        if (this.isPunct("(")) throw new ExpressionError(`Methods like .${name.value}() are not supported`);
        node = { op: "get", of: node, key: { op: "lit", v: name.value } };
        continue;
      }
      if (this.isPunct("[")) {
        this.index += 1;
        const key = this.expression();
        this.expect("]");
        node = { op: "get", of: node, key };
        continue;
      }
      return node;
    }
  }

  private args(): AidenUiExprV1[] {
    const args: AidenUiExprV1[] = [];
    if (this.isPunct(")")) {
      this.index += 1;
      return args;
    }
    while (true) {
      args.push(this.expression());
      if (this.isPunct(",")) {
        this.index += 1;
        continue;
      }
      this.expect(")");
      return args;
    }
  }

  private primary(): AidenUiExprV1 {
    const token = this.peek();
    if (!token) throw new ExpressionError("Unexpected end of expression");
    this.index += 1;
    switch (token.type) {
      case "num":
        return { op: "lit", v: token.value };
      case "str":
        return { op: "lit", v: token.value };
      case "var":
        return { op: "var", name: token.value };
      case "ident": {
        if (token.value === "true" || token.value === "false") return { op: "lit", v: token.value === "true" };
        if (token.value === "null") return { op: "lit", v: null };
        if (this.isPunct("(")) {
          if (ACTIONS.has(token.value)) throw new ExpressionError(`${token.value}() is only allowed as a whole action`);
          if (!FUNCTIONS.has(token.value as AidenUiFunctionName)) {
            throw new ExpressionError(`Unknown function ${token.value}()`);
          }
          this.index += 1;
          return { op: "call", fn: token.value as AidenUiFunctionName, a: this.args() };
        }
        // Lenient: a bare name reads a binding, as if it had a `$`.
        return { op: "var", name: token.value };
      }
      case "punct":
        if (token.value === "(") {
          const inner = this.expression();
          this.expect(")");
          return inner;
        }
        if (token.value === "{" || token.value === "[") {
          this.index -= 1;
          return { op: "json", v: this.literal() };
        }
        throw new ExpressionError(`Unexpected "${token.value}"`);
    }
  }

  /** A constant JSON-ish literal with unquoted keys allowed. */
  private literal(): unknown {
    const token = this.peek();
    if (!token) throw new ExpressionError("Unexpected end of literal");
    this.index += 1;
    if (token.type === "num" || token.type === "str") return token.value;
    if (token.type === "ident") {
      if (token.value === "true") return true;
      if (token.value === "false") return false;
      if (token.value === "null") return null;
      throw new ExpressionError("Object and array literals must be constant");
    }
    if (token.type === "var") throw new ExpressionError("Object and array literals must be constant");
    if (token.value === "-" || token.value === "+") {
      const number = this.peek();
      if (number?.type !== "num") throw new ExpressionError("A sign must precede a number");
      this.index += 1;
      return token.value === "-" ? -number.value : number.value;
    }
    if (token.value === "[") {
      const items: unknown[] = [];
      while (!this.isPunct("]")) {
        items.push(this.literal());
        if (this.isPunct(",")) this.index += 1;
        else if (!this.isPunct("]")) throw new ExpressionError('Expected "," or "]"');
      }
      this.index += 1;
      return items;
    }
    if (token.value === "{") {
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      while (!this.isPunct("}")) {
        const key = this.peek();
        if (key?.type !== "ident" && key?.type !== "str") throw new ExpressionError("Expected an object key");
        this.index += 1;
        this.expect(":");
        object[key.value] = this.literal();
        if (this.isPunct(",")) this.index += 1;
        else if (!this.isPunct("}")) throw new ExpressionError('Expected "," or "}"');
      }
      this.index += 1;
      return { ...object };
    }
    throw new ExpressionError(`Unexpected "${token.value}"`);
  }
}

export function parseExpression(source: string): { expr?: AidenUiExprV1; action?: AidenUiActionV1; error?: string } {
  if (source.length > MAX_SOURCE_CHARS) return { error: "Expression is too long" };
  try {
    const tokens = tokenize(source);
    if (tokens.length === 0) return { error: "Empty expression" };
    const parser = new Parser(tokens);
    const action = parser.action();
    if (action) {
      if (!parser.done()) return { error: "Unexpected input after the action" };
      return { action };
    }
    const expr = parser.expression();
    if (!parser.done()) return { error: "Unexpected input after the expression" };
    return { expr };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid expression" };
  }
}
