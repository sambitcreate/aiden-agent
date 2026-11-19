// Reads artifact HTML the way a browser does, to find markup that would load
// or run something. parse5 (already a production dependency) tokenizes and
// builds the tree, so comments, RCDATA (<textarea>, <title>), raw text
// (<style>, <xmp>, <noscript> with scripting on...), script data, and foreign
// <svg>/<math> content (where <style> and <script> hold markup) are exactly
// what the browser sees. Elements are checked as the parser creates them, so
// a tag inside a <template>, or one the tree builder moves, still counts.
//
// One scanner reads a whole visual, or a streaming draft chunk by chunk:
// each chunk is parsed once, so a draft costs no more than the finished
// visual. A tag still being written at the end of a chunk is checked as far
// as it goes (reread while short, then each time it doubles), which is also
// how the finished check treats a tag left open at the end (the wrapper's
// closing tags would otherwise finish it).
//
// The checks refuse an embedding tag, a <script src>, a refresh <meta>, a
// javascript: or data:text/html URL in a URL attribute, CSS url() or an SVG
// <set>/<animate> of href, a remote src, and JavaScript (in <script> or an
// on* attribute) that sends such a URL to a navigation or URL sink or writes
// such markup through an HTML sink. Labels ("JavaScript: 41%"), comparisons
// in scripts ("i<base && i>0") and plain strings pass; the sandbox's CSP is
// what actually blocks loads.

import { Parser, Token, defaultTreeAdapter, type DefaultTreeAdapterMap, type DefaultTreeAdapterTypes, type TreeAdapter } from "parse5";

type Element = DefaultTreeAdapterTypes.Element;

export interface HtmlFindings {
  /** The first embedding tag, external script or refresh meta. */
  embed?: string;
  /** The first unsafe URL, remote src, or unsafe script sink. */
  url?: string;
  /** Why the markup is too large in structure to read in bounded time. */
  limit?: string;
}

/**
 * Structure limits that keep a check linear in the visual's size. The parser
 * walks the open elements and an element's attributes per tag, so nesting and
 * attribute counts are capped; implied and reconstructed elements are capped
 * in total, and so is content the parser moves out of a table (it is placed
 * before the table, among that table's siblings). No real visual comes near
 * them.
 */
export const MAX_HTML_NESTING_DEPTH = 512;
export const MAX_HTML_ELEMENT_ATTRIBUTES = 512;
export const MAX_HTML_ELEMENTS = 262_144;
export const MAX_HTML_FOSTER_PARENTED = 16_384;

class StructureLimit extends Error {}

const EMBEDDING_TAGS: ReadonlySet<string> = new Set(["iframe", "object", "embed", "applet", "frame", "frameset", "base", "link"]);
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "src", "action", "formaction", "xlink:href", "data"]);
const SCRIPT_SOURCE_ATTRIBUTES: ReadonlySet<string> = new Set(["src", "href", "xlink:href"]);
const SMIL_ELEMENTS: ReadonlySet<string> = new Set(["set", "animate"]);
const SMIL_VALUE_ATTRIBUTES: ReadonlySet<string> = new Set(["to", "from", "by", "values"]);
const UNSAFE_SCHEME = /^(?:javascript:|data:\s*text\/html)/u;
/** An unfinished start tag up to this many characters is read again on every chunk. */
const PENDING_TAG_REREAD_SIZE = 1024;
/** HTML handed to a sink is parsed again, at most this many strings deep. */
const MAX_NESTED_HTML_DEPTH = 3;

function attributeName(attribute: Token.Attribute): string {
  return (attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name).toLowerCase();
}

/**
 * A URL as the URL parser sees it: leading controls and spaces dropped, tabs
 * and newlines dropped, lowercased. Only the first characters after the
 * leading run are read, which is all a scheme needs.
 */
function urlStart(value: string, length = 64): string {
  let at = 0;
  while (at < value.length && value.charCodeAt(at) <= 0x20) at += 1;
  let start = "";
  for (; at < value.length && start.length < length; at += 1) {
    const char = value[at]!;
    if (char !== "\t" && char !== "\n" && char !== "\r") start += char;
  }
  return start.toLowerCase();
}

function isUnsafeUrl(value: string): boolean {
  return UNSAFE_SCHEME.test(urlStart(value));
}

function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//u.test(urlStart(value));
}

function attributeText(attribute: Token.Attribute): string {
  return `${attributeName(attribute)}="${attribute.value.replace(/"/gu, "&quot;")}"`;
}

function tagText(tagName: string, attributes: readonly Token.Attribute[]): string {
  return `<${tagName}${attributes.map((attribute) => ` ${attributeText(attribute)}`).join("")}>`;
}

/** The first `url(` in CSS whose target is javascript: or data:text/html. */
export function findCssUnsafeUrl(css: string): string | undefined {
  const call = /(?<![\w-])url\(/giu;
  for (let match = call.exec(css); match; match = call.exec(css)) {
    let at = match.index + match[0].length;
    while (at < css.length && /\s/u.test(css[at]!)) at += 1;
    if (css[at] === '"' || css[at] === "'") at += 1;
    const target = css.slice(at, at + 48).replace(/\s+/gu, "").toLowerCase();
    if (/^(?:javascript:|data:text\/html)/u.test(target)) return css.slice(match.index, Math.min(css.length, at + 24));
  }
  return undefined;
}

// --- JavaScript ---------------------------------------------------------

interface JsToken {
  kind: "name" | "punct" | "string" | "template" | "other";
  text: string;
  start: number;
  end: number;
  /** A string's cooked value, or a template's text up to its first `${`. */
  value?: string;
  /** A template's text parts, joined. */
  parts?: string;
  /** A template with a `${...}` substitution. */
  substituted?: boolean;
  /** A `)` that ends an `if`, `while`, `for` or `with` head, after which a statement starts. */
  closesHead?: boolean;
  /** A `}` that ends a template's last substitution and the template with it. */
  closesTemplate?: boolean;
  /** A `++` or `--` that follows its operand on the same line. */
  postfix?: boolean;
}

const PUNCTUATORS = [
  ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
];
/** Reserved words after which an expression, so a regex, starts. */
const REGEX_AFTER_KEYWORDS: ReadonlySet<string> = new Set([
  "return", "typeof", "case", "do", "else", "in", "instanceof", "new", "delete", "void", "throw",
]);
/** Words that are keywords in some code (generators, async functions, for-of heads) and plain names in other code. */
const CONTEXTUAL_KEYWORDS: ReadonlySet<string> = new Set(["yield", "await", "of"]);
/** Keywords whose parenthesized head is followed by a statement, where `/` starts a regex. */
const HEAD_KEYWORDS: ReadonlySet<string> = new Set(["if", "while", "for", "with"]);
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
const IDENTIFIER_START = /[\p{ID_Start}$_]/u;
const IDENTIFIER_PART = /[\p{ID_Continue}$_‌‍]/u;
const LINE_BREAK = /[\n\r\u2028\u2029]/u;

/** Reads one escape at `at` (just past the backslash); returns the cooked text and the index after it. */
function readEscape(code: string, at: number): [string, number] {
  const char = code[at];
  if (char === undefined) return ["", at];
  if (char === "\r") return ["", code[at + 1] === "\n" ? at + 2 : at + 1];
  if (char === "\n" || char === " " || char === " ") return ["", at + 1];
  if (char === "x") {
    const hex = /^[0-9a-f]{2}/iu.exec(code.slice(at + 1, at + 3));
    if (hex) return [String.fromCharCode(Number.parseInt(hex[0], 16)), at + 3];
  }
  if (char === "u") {
    const braced = /^\{([0-9a-f]{1,6})\}/iu.exec(code.slice(at + 1, at + 9));
    if (braced) {
      const point = Number.parseInt(braced[1]!, 16);
      return [point <= 0x10ffff ? String.fromCodePoint(point) : "", at + 1 + braced[0].length];
    }
    const hex = /^[0-9a-f]{4}/iu.exec(code.slice(at + 1, at + 5));
    if (hex) return [String.fromCharCode(Number.parseInt(hex[0], 16)), at + 5];
  }
  return [SIMPLE_ESCAPES[char] ?? char, at + 1];
}

/** An immutable stack, so a second reading can start from the first one's state and be compared with it cheaply. */
interface Stack<T> {
  readonly top: T;
  readonly below: Stack<T> | undefined;
}

interface LexState {
  at: number;
  /** For each open `{` or `${`: the template token a `}` resumes, or null. */
  braces: Stack<JsToken | null> | undefined;
  /** For each open `(`: whether it starts an `if`/`while`/`for`/`with` head. */
  parens: Stack<boolean> | undefined;
  /** The last three tokens, oldest first. */
  tail: JsToken[];
  /** A line break since the last token. */
  lineBreak: boolean;
}

/** A place the code reads two ways: the state there and the number of tokens before it. */
interface LexFork {
  state: LexState;
  tokenIndex: number;
}

const isOperandEnd = (token: JsToken | undefined): boolean => {
  if (token === undefined) return false;
  if (token.kind === "name") return !REGEX_AFTER_KEYWORDS.has(token.text);
  if (token.kind === "punct") return token.text === ")" || token.text === "]" || token.closesTemplate === true;
  return true;
};

/**
 * Splits JavaScript into tokens, linearly. Strings and regular expressions
 * end at a line break, so a misread `/` costs at most the rest of its line.
 *
 * Some places read two ways without parsing the whole program: a `/` after
 * `}` (a block or an object), after `)`, after `++`/`--`, or after yield,
 * await or of (keywords or plain names), and an HTML-like comment (`<!--`,
 * or `-->` starting a line), which classic scripts skip and modules read as
 * operators. The first reading takes the likelier one and records each such
 * place as a fork; `readOtherWay` then lexes the other reading from there
 * until the two meet again.
 */
class JsLexer {
  readonly tokens: JsToken[] = [];
  readonly forks: LexFork[] = [];
  /** For the first reading: the state before each token that starts a step, indexed like `tokens`. */
  readonly bracesAt: (Stack<JsToken | null> | undefined)[] = [];
  readonly parensAt: (Stack<boolean> | undefined)[] = [];
  readonly lineBreakAt: boolean[] = [];
  readonly stepAt: boolean[] = [];
  at: number;
  braces: Stack<JsToken | null> | undefined;
  parens: Stack<boolean> | undefined;
  tail: JsToken[];
  lineBreak: boolean;

  constructor(
    private readonly code: string,
    state: LexState,
    /** The fork this lexer reads the other way, or undefined for the first reading. */
    private readonly flipAt?: number,
  ) {
    this.at = state.at;
    this.braces = state.braces;
    this.parens = state.parens;
    this.tail = [...state.tail];
    this.lineBreak = state.lineBreak;
  }

  private get first(): boolean {
    return this.flipAt === undefined;
  }

  private state(): LexState {
    return { at: this.at, braces: this.braces, parens: this.parens, tail: [...this.tail], lineBreak: this.lineBreak };
  }

  /** Takes the likelier reading of an ambiguous place, or the other one at the fork being reread. */
  private choose(likelier: boolean): boolean {
    if (this.at === this.flipAt) return !likelier;
    if (this.first) this.forks.push({ state: this.state(), tokenIndex: this.tokens.length });
    return likelier;
  }

  private push(token: JsToken): void {
    this.tokens.push(token);
    this.tail.push(token);
    if (this.tail.length > 3) this.tail.shift();
    this.lineBreak = false;
  }

  /** Lexes the whole code (the first reading). */
  run(): void {
    while (this.skipTrivia()) {
      this.bracesAt[this.tokens.length] = this.braces;
      this.parensAt[this.tokens.length] = this.parens;
      this.lineBreakAt[this.tokens.length] = this.lineBreak;
      this.stepAt[this.tokens.length] = true;
      this.step();
    }
  }

  /** Skips white space and comments; returns whether a token follows. */
  skipTrivia(): boolean {
    const code = this.code;
    while (this.at < code.length) {
      const char = code[this.at]!;
      if (/\s/u.test(char)) {
        if (LINE_BREAK.test(char)) this.lineBreak = true;
        this.at += 1;
        continue;
      }
      const lineComment =
        (char === "/" && code[this.at + 1] === "/") ||
        (char === "<" && code.startsWith("<!--", this.at) && this.choose(true)) ||
        (char === "-" && code.startsWith("-->", this.at) && (this.lineBreak || this.tail.length === 0) && this.choose(true));
      if (lineComment) {
        while (this.at < code.length && !LINE_BREAK.test(code[this.at]!)) this.at += 1;
        continue;
      }
      if (char === "/" && code[this.at + 1] === "*") {
        const close = code.indexOf("*/", this.at + 2);
        const end = close === -1 ? code.length : close + 2;
        if (LINE_BREAK.test(code.slice(this.at, end))) this.lineBreak = true;
        this.at = end;
        continue;
      }
      return true;
    }
    return false;
  }

  /** Whether a `/` here starts a regex. */
  private regexAllowed(): boolean {
    const previous = this.tail[this.tail.length - 1];
    if (previous === undefined) return true;
    const before = this.tail[this.tail.length - 2];
    if (previous.kind === "name") {
      if (before?.kind === "punct" && (before.text === "." || before.text === "?.")) return false;
      if (REGEX_AFTER_KEYWORDS.has(previous.text)) return true;
      return CONTEXTUAL_KEYWORDS.has(previous.text) ? this.choose(true) : false;
    }
    if (previous.kind !== "punct") return false;
    switch (previous.text) {
      case ")":
        return previous.closesHead === true || this.choose(false);
      case "]":
        return false;
      case "}":
        return previous.closesTemplate === true ? false : this.choose(true);
      case "++":
      case "--":
        return this.choose(previous.postfix !== true);
      default:
        return true;
    }
  }

  /** Reads template text from `at` (after "`" or "}") into `token`; returns the index after it. */
  private readTemplate(token: JsToken, at: number): number {
    const code = this.code;
    let text = "";
    while (at < code.length) {
      const char = code[at]!;
      if (char === "`") {
        token.parts = (token.parts ?? "") + text;
        if (!token.substituted) token.value = (token.value ?? "") + text;
        token.end = at + 1;
        return at + 1;
      }
      if (char === "$" && code[at + 1] === "{") {
        token.parts = (token.parts ?? "") + text;
        if (!token.substituted) token.value = (token.value ?? "") + text;
        token.substituted = true;
        token.end = at + 2;
        this.braces = { top: token, below: this.braces };
        return at + 2;
      }
      if (char === "\\") {
        const [cooked, next] = readEscape(code, at + 1);
        text += cooked;
        at = next;
        continue;
      }
      text += char;
      at += 1;
    }
    token.parts = (token.parts ?? "") + text;
    if (!token.substituted) token.value = (token.value ?? "") + text;
    token.end = code.length;
    return code.length;
  }

  /** Lexes the token at `at`, after `skipTrivia` returned true. */
  step(): void {
    const code = this.code;
    const char = code[this.at]!;
    const start = this.at;
    if (char === "/") {
      if (this.regexAllowed()) {
        let at = this.at + 1;
        let inClass = false;
        while (at < code.length && !LINE_BREAK.test(code[at]!)) {
          const next = code[at]!;
          if (next === "\\") at += 2;
          else {
            at += 1;
            if (next === "[") inClass = true;
            else if (next === "]") inClass = false;
            else if (next === "/" && !inClass) break;
          }
        }
        while (at < code.length && IDENTIFIER_PART.test(code[at]!)) at += 1;
        this.at = at;
        this.push({ kind: "other", text: "regex", start, end: at });
        return;
      }
      const text = code[this.at + 1] === "=" ? "/=" : "/";
      this.at += text.length;
      this.push({ kind: "punct", text, start, end: this.at });
      return;
    }
    if (char === '"' || char === "'") {
      let at = this.at + 1;
      let value = "";
      while (at < code.length && code[at] !== char && code[at] !== "\n" && code[at] !== "\r") {
        if (code[at] === "\\") {
          const [cooked, next] = readEscape(code, at + 1);
          value += cooked;
          at = next;
        } else {
          value += code[at];
          at += 1;
        }
      }
      if (code[at] === char) at += 1;
      this.at = at;
      this.push({ kind: "string", text: code.slice(start, at), start, end: at, value });
      return;
    }
    if (char === "`") {
      const token: JsToken = { kind: "template", text: "`", start, end: start + 1, value: "", parts: "" };
      this.push(token);
      this.at = this.readTemplate(token, this.at + 1);
      if (token.substituted && this.braces?.top === token) this.push({ kind: "punct", text: "${", start: token.end - 2, end: token.end });
      return;
    }
    if (char === "}" && this.braces !== undefined && this.braces.top !== null) {
      // The other reading copies a template it resumes, so the first reading's tokens stay as they are.
      const template = this.first ? this.braces.top : { ...this.braces.top };
      this.braces = this.braces.below;
      const close: JsToken = { kind: "punct", text: "}", start, end: start + 1 };
      this.push(close);
      const below = this.braces;
      this.at = this.readTemplate(template, this.at + 1);
      if (this.braces !== below) this.push({ kind: "punct", text: "${", start: template.end - 2, end: template.end });
      else close.closesTemplate = true;
      return;
    }
    if (IDENTIFIER_START.test(char) || char === "\\") {
      let at = this.at + 1;
      while (at < code.length && (IDENTIFIER_PART.test(code[at]!) || code[at] === "\\")) at += 1;
      this.at = at;
      this.push({ kind: "name", text: code.slice(start, at), start, end: at });
      return;
    }
    if (/[0-9]/u.test(char) || (char === "." && /[0-9]/u.test(code[this.at + 1] ?? ""))) {
      let at = this.at + 1;
      while (at < code.length && /[0-9a-z_.]/iu.test(code[at]!)) at += 1;
      this.at = at;
      this.push({ kind: "other", text: code.slice(start, at), start, end: at });
      return;
    }
    const punctuator = PUNCTUATORS.find((candidate) => code.startsWith(candidate, this.at)) ?? char;
    this.at += punctuator.length;
    const token: JsToken = { kind: "punct", text: punctuator, start, end: this.at };
    if (punctuator === "{") this.braces = { top: null, below: this.braces };
    else if (punctuator === "}") this.braces = this.braces?.below;
    else if (punctuator === "++" || punctuator === "--") {
      // A line break before ++ or -- ends the statement, so it applies to what follows.
      token.postfix = !this.lineBreak && isOperandEnd(this.tail[this.tail.length - 1]);
    } else if (punctuator === "(") {
      // A keyword read as a property (`o.if(`, `[].with(`) is a method call,
      // not a statement head, so the `/` after its `)` divides.
      const tail = this.tail;
      const followsDot = (offset: number) => {
        const previous = tail[tail.length - offset];
        return previous?.kind === "punct" && (previous.text === "." || previous.text === "?.");
      };
      const last = tail[tail.length - 1];
      const before = tail[tail.length - 2];
      const head =
        last?.kind === "name" &&
        ((HEAD_KEYWORDS.has(last.text) && !followsDot(2)) ||
          (last.text === "await" && before?.kind === "name" && before.text === "for" && !followsDot(3)));
      this.parens = { top: head, below: this.parens };
    } else if (punctuator === ")") {
      if (this.parens?.top === true) token.closesHead = true;
      this.parens = this.parens?.below;
    }
    this.push(token);
  }
}

/** The first token of `tokens` that starts at or after `at`. */
function tokenIndexAt(tokens: readonly JsToken[], at: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tokens[middle]!.start < at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Names that may follow a regex literal on the same line: binary operators spelled as words. */
const OPERATOR_WORDS: ReadonlySet<string> = new Set(["in", "instanceof", "of"]);

interface OtherReading {
  tokens: JsToken[];
  /** The first reading's token index to continue from. */
  resume: number;
  /** Characters read plus tokens made. */
  cost: number;
  /** This reading is a syntax error, so a browser that took it would run nothing. */
  dead?: boolean;
}

/**
 * Lexes `fork` the other way until it meets the first reading (the same
 * place, open brackets and last tokens) or the code ends. It stops early,
 * with a cost above `budget`, once it has spent more than `budget`: the caller
 * then refuses the script as too complex, since the rest of this reading was
 * never checked.
 *
 * A reading that takes the fork's `/` as a regex followed on the same line by
 * a name, number or string is a syntax error (no semicolon is inserted
 * there), and a script with a syntax error runs nothing, so that reading
 * stops there, marked dead. Only the fork's own regex is judged this way: past
 * it this reading takes the likelier side of later forks, which the browser
 * might not.
 */
function readOtherWay(code: string, first: JsLexer, fork: LexFork, budget: number): OtherReading {
  const from = fork.state.at;
  const other = new JsLexer(code, fork.state, from);
  while (other.skipTrivia()) {
    if (other.tokens.length === 1 && other.tokens[0]!.start === from && other.tokens[0]!.text === "regex" && !other.lineBreak) {
      const char = code[other.at]!;
      const word = IDENTIFIER_START.test(char) ? /^[\p{ID_Continue}$\u200c\u200d]*/u.exec(code.slice(other.at, other.at + 16))![0] : undefined;
      if ((word !== undefined && !OPERATOR_WORDS.has(word)) || /[0-9"']/u.test(char)) {
        return { tokens: [], resume: fork.tokenIndex, cost: other.at - from + 1, dead: true };
      }
    }
    if (other.at > from) {
      const index = tokenIndexAt(first.tokens, other.at);
      const token = first.tokens[index];
      if (
        token?.start === other.at &&
        first.stepAt[index] === true &&
        first.bracesAt[index] === other.braces &&
        first.parensAt[index] === other.parens &&
        first.lineBreakAt[index] === other.lineBreak &&
        sameTail(first.tokens, index, other.tail)
      ) {
        return { tokens: other.tokens, resume: index, cost: other.at - from + other.tokens.length };
      }
      if (other.at - from + other.tokens.length > budget) return { tokens: other.tokens, resume: index, cost: other.at - from + other.tokens.length };
    }
    other.step();
  }
  return { tokens: other.tokens, resume: first.tokens.length, cost: other.at - from + other.tokens.length };
}

function sameTail(tokens: readonly JsToken[], index: number, tail: readonly JsToken[]): boolean {
  const count = Math.min(3, index);
  if (tail.length !== count) return false;
  for (let offset = 1; offset <= count; offset += 1) {
    const a = tokens[index - offset]!;
    const b = tail[tail.length - offset]!;
    if (a.start !== b.start || a.end !== b.end || a.text !== b.text) return false;
  }
  return true;
}

const URL_PROPERTIES: ReadonlySet<string> = new Set(["href", "src", "action", "formAction"]);
const HTML_PROPERTIES: ReadonlySet<string> = new Set(["innerHTML", "outerHTML", "srcdoc"]);
const HTML_CALLS: Readonly<Record<string, number | "any">> = {
  insertAdjacentHTML: 1,
  write: "any",
  writeln: "any",
  setHTMLUnsafe: 0,
  createContextualFragment: 0,
  parseHTMLUnsafe: 0,
};

interface CallFrame {
  call: boolean;
  callee?: string;
  receiver?: string;
  start: number;
  argument: number;
  hasArgument: boolean;
  /** The plain string value of each argument that is a single literal. */
  literals: (string | undefined)[];
  /** A `replace(...)` call's unsafe first argument, flagged only if it is the only argument. */
  deferred?: string;
}

const isLiteral = (token: JsToken | undefined): token is JsToken => token?.kind === "string" || token?.kind === "template";
const isDot = (token: JsToken | undefined) => token?.kind === "punct" && (token.text === "." || token.text === "?.");
const isPunct = (token: JsToken | undefined, text: string) => token?.kind === "punct" && token.text === text;

const copyFrames = (stack: readonly CallFrame[]): CallFrame[] => stack.map((frame) => ({ ...frame, literals: [...frame.literals] }));

function sameFrame(a: CallFrame, b: CallFrame): boolean {
  return (
    a.call === b.call &&
    a.callee === b.callee &&
    a.receiver === b.receiver &&
    a.start === b.start &&
    a.argument === b.argument &&
    a.deferred === b.deferred &&
    a.literals.length === b.literals.length &&
    a.literals.every((literal, index) => literal === b.literals[index])
  );
}

/** How many frames from the bottom two stacks share, or -1 when they are the same. */
function sharedFrames(a: readonly CallFrame[], b: readonly CallFrame[]): number {
  const count = Math.min(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    if (!sameFrame(a[index]!, b[index]!)) return index;
  }
  return a.length === b.length ? -1 : count;
}

/** Tokens of the first reading kept before and after the other reading of a fork, for the sink rules' look-behind and look-ahead. */
const FORK_LEAD_TOKENS = 8;
const FORK_TRAIL_TOKENS = 8;
/**
 * Reading each fork the other way, copying the call frames for it and
 * checking the first reading after it until the two agree may cost this many
 * units per character of code in all: a character read or a token or frame
 * handled is one unit. Ordinary scripts use well under one per character.
 */
const FORK_BUDGET_PER_CHARACTER = 8;
const FORK_BUDGET_FLOOR = 65_536;

/**
 * The first place `code` sends a javascript: or data:text/html URL to a
 * navigation or URL sink, or unsafe markup to an HTML sink. Literals joined
 * with `+` are read as one value; a template's URL ends at its first `${`.
 * A place that reads two ways (see `JsLexer`) is checked both ways.
 */
export function findJsSink(code: string, depth = 0): HtmlFindings {
  const lexer = new JsLexer(code, { at: 0, braces: undefined, parens: undefined, tail: [], lineBreak: false });
  lexer.run();
  const tokens = lexer.tokens;
  let found: HtmlFindings = {};
  const note = (findings: HtmlFindings) => {
    found = { ...found, embed: found.embed ?? findings.embed, url: found.url ?? findings.url ?? findings.limit };
  };
  const done = () => found.limit !== undefined || (found.embed !== undefined && found.url !== undefined);
  let budget = FORK_BUDGET_PER_CHARACTER * code.length + FORK_BUDGET_FLOOR;
  const spend = (units: number) => {
    budget -= units;
    if (budget < 0) found.limit ??= "a script reads two ways in too many places";
  };

  // Read every fork the other way first, so the first reading's scan can keep
  // its call frames both where each fork starts and where the readings meet.
  const others: (OtherReading & { meet: number })[] = [];
  for (const fork of lexer.forks) {
    const other = readOtherWay(code, lexer, fork, budget);
    spend(other.cost);
    if (found.limit !== undefined) return found;
    // Past the meeting point, keep a chain of literals joined with `+` whole.
    let meet = Math.min(other.resume + FORK_TRAIL_TOKENS, tokens.length);
    while (meet < tokens.length && (isPunct(tokens[meet], "+") ? isLiteral(tokens[meet - 1]) : isLiteral(tokens[meet]) && isPunct(tokens[meet - 1], "+"))) {
      meet += 1;
    }
    others.push({ ...other, meet });
  }
  const snapshots: { index: number; fork: number; meet: boolean }[] = [];
  lexer.forks.forEach((fork, index) => {
    snapshots.push({ index: fork.tokenIndex, fork: index, meet: false }, { index: others[index]!.meet, fork: index, meet: true });
  });
  snapshots.sort((a, b) => a.index - b.index);
  const atFork: CallFrame[][] = [];
  const atMeet: CallFrame[][] = [];
  const stack: CallFrame[] = [];
  let next = 0;
  const copyUpTo = (index: number) => {
    while (next < snapshots.length && snapshots[next]!.index <= index && found.limit === undefined) {
      const snapshot = snapshots[next]!;
      spend(stack.length + 1);
      (snapshot.meet ? atMeet : atFork)[snapshot.fork] = copyFrames(stack);
      next += 1;
    }
  };
  scanJsTokens(code, tokens, 0, stack, depth, note, done, copyUpTo);
  copyUpTo(Number.POSITIVE_INFINITY);

  lexer.forks.forEach((fork, index) => {
    const other = others[index]!;
    if (done() || other.dead === true) return;
    const frames = atFork[index]!;
    const lead = Math.max(0, fork.tokenIndex - FORK_LEAD_TOKENS);
    const joined = [...tokens.slice(lead, fork.tokenIndex), ...other.tokens, ...tokens.slice(other.resume, other.meet)];
    spend(joined.length);
    scanJsTokens(code, joined, fork.tokenIndex - lead, frames, depth, note, done);
    // Past this point both readings see the same tokens, but the call frames
    // they open may differ (an argument counted in one reading only). Keep
    // reading with this reading's frames until those frames close.
    const shared = sharedFrames(frames, atMeet[index]!);
    if (shared === -1 || done()) return;
    const level = frames.length === atMeet[index]!.length ? shared : -1;
    scanJsTokens(code, tokens, other.meet, frames, depth, note, () => done() || frames.length <= level, () => spend(1));
  });
  return found;
}

/** Runs the sink rules over `tokens` from `from`, with the call frames open there. */
function scanJsTokens(
  code: string,
  tokens: readonly JsToken[],
  from: number,
  stack: CallFrame[],
  depth: number,
  note: (findings: HtmlFindings) => void,
  done: () => boolean,
  visit?: (index: number) => void,
): void {
  for (let index = from; index < tokens.length && !done(); index += 1) {
    visit?.(index);
    const token = tokens[index]!;
    if (token.kind === "punct") {
      if (token.text === "(") {
        const callee = tokens[index - 1];
        stack.push({
          call: callee?.kind === "name",
          callee: callee?.kind === "name" ? callee.text : undefined,
          receiver: isDot(tokens[index - 2]) && tokens[index - 3]?.kind === "name" ? tokens[index - 3]!.text : undefined,
          start: callee?.start ?? token.start,
          argument: 0,
          hasArgument: false,
          literals: [],
        });
      } else if (token.text === "[" || token.text === "{" || token.text === "${") {
        stack.push({ call: false, start: token.start, argument: 0, hasArgument: false, literals: [] });
      } else if (token.text === ",") {
        const frame = stack[stack.length - 1];
        if (frame) frame.argument += 1;
      } else if (token.text === ")" || token.text === "]" || token.text === "}") {
        const frame = stack.pop();
        if (frame?.deferred !== undefined && frame.argument === 0) note({ url: code.slice(frame.start, token.end) });
      }
      const frame = stack[stack.length - 1];
      if (frame && token.text !== "(" && token.text !== ",") frame.hasArgument = true;
      continue;
    }
    const frame = stack[stack.length - 1];
    if (frame && !isPunct(token, ",")) frame.hasArgument = true;
    if (!isLiteral(token) || isPunct(tokens[index - 1], "+")) continue;

    // A chain of literals joined by `+`, read as one value.
    let chainEnd = index;
    let url = token.value ?? "";
    let urlOpen = !token.substituted;
    let markup = token.kind === "template" ? (token.parts ?? "") : (token.value ?? "");
    while (isPunct(tokens[chainEnd + 1], "+") && isLiteral(tokens[chainEnd + 2])) {
      const next = tokens[chainEnd + 2]!;
      if (urlOpen && url.length < 64) url += next.value ?? "";
      urlOpen &&= !next.substituted;
      markup += next.kind === "template" ? (next.parts ?? "") : (next.value ?? "");
      chainEnd += 2;
    }
    const end = tokens[chainEnd]!.end;
    const previous = tokens[index - 1];
    let sink: "url" | "html" | undefined;
    let sinkStart = token.start;

    if (isPunct(previous, "=") || isPunct(previous, "+=")) {
      const target = tokens[index - 2];
      let property: string | undefined;
      let viaDot = false;
      if (target?.kind === "name") {
        property = target.text;
        viaDot = isDot(tokens[index - 3]);
        sinkStart = (viaDot ? tokens[index - 4] : target)?.start ?? target.start;
      } else if (isPunct(target, "]") && isLiteral(tokens[index - 3]) && isPunct(tokens[index - 4], "[")) {
        property = tokens[index - 3]!.value;
        viaDot = true;
        sinkStart = tokens[index - 5]?.start ?? tokens[index - 4]!.start;
      }
      if (property !== undefined) {
        if (property === "location" || (viaDot && URL_PROPERTIES.has(property))) sink = "url";
        else if (viaDot && HTML_PROPERTIES.has(property)) sink = "html";
      }
    } else if (isPunct(previous, ":")) {
      const key = tokens[index - 2];
      const keyName = key?.kind === "name" ? key.text : isLiteral(key) ? key.value : undefined;
      const before = tokens[index - 3];
      if (keyName !== undefined && URL_PROPERTIES.has(keyName) && (isPunct(before, "{") || isPunct(before, ","))) {
        sink = "url";
        sinkStart = key!.start;
      }
    } else if (frame?.call && (isPunct(previous, "(") || isPunct(previous, ","))) {
      const argument = frame.argument;
      if (chainEnd === index && token.kind === "string") frame.literals[argument] = token.value;
      const callee = frame.callee ?? "";
      sinkStart = frame.start;
      if ((callee === "open" || callee === "assign") && argument === 0) sink = "url";
      else if (callee === "replace" && argument === 0) {
        if (frame.receiver === "location") sink = "url";
        else if (isUnsafeUrl(url)) frame.deferred = url;
      } else if (callee === "setAttribute" && argument === 1) {
        const name = frame.literals[0]?.toLowerCase();
        if (name !== undefined && URL_ATTRIBUTES.has(name)) sink = "url";
        else if (name === "srcdoc") sink = "html";
      } else if (callee === "setAttributeNS" && argument === 2) {
        const name = frame.literals[1]?.toLowerCase();
        if (name !== undefined && URL_ATTRIBUTES.has(name)) sink = "url";
      } else if (callee in HTML_CALLS) {
        const at = HTML_CALLS[callee];
        if (at === "any" || at === argument) sink = "html";
      }
    }

    if (sink === "url" && isUnsafeUrl(url)) note({ url: code.slice(sinkStart, end) });
    else if (sink === "html" && depth < MAX_NESTED_HTML_DEPTH && markup.includes("<")) {
      note(scanHtmlString(markup, depth + 1));
    }
    index = chainEnd;
  }
}

// --- HTML ---------------------------------------------------------------

interface TokenizerInternals {
  currentToken: Token.Token | null;
  currentAttr?: { name: string; value: string };
  currentCharacterToken?: { chars: string } | null;
  _leaveAttrName(): void;
}

/**
 * A browser-faithful HTML scanner that can be fed a document in chunks.
 * `findings()` reports what the HTML so far would do, counting a tag that is
 * still being written.
 */
export class HtmlScanner {
  private readonly parser: Parser<DefaultTreeAdapterMap>;
  private readonly committed: HtmlFindings = {};
  /** <script> and <style> elements whose text has not been checked yet. */
  private readonly rawText = new Set<Element>();
  private finished = false;
  private elements = 0;
  private fosterParented = 0;
  /** The unfinished start tag last read by `findings`, its size then and what it would load. */
  private pending: { tag: unknown; size: number; found: HtmlFindings } | undefined;

  /**
   * `scripting` is the parser's scripting flag: on, `<noscript>` holds raw
   * text (a frame that runs scripts); off, it holds markup (a viewer or an
   * exported page with scripts turned off). Only `<noscript>` reads
   * differently between the two.
   */
  constructor(
    private readonly depth = 0,
    scripting = true,
  ) {
    const adapter: TreeAdapter<DefaultTreeAdapterMap> = {
      ...defaultTreeAdapter,
      createElement: (tagName, namespaceURI, attrs) => {
        this.elements += 1;
        if (this.elements > MAX_HTML_ELEMENTS) {
          throw new StructureLimit(`it builds more than ${MAX_HTML_ELEMENTS.toLocaleString("en-US")} elements`);
        }
        if (this.parser.openElements.stackTop + 1 >= MAX_HTML_NESTING_DEPTH) {
          throw new StructureLimit(`elements nest more than ${MAX_HTML_NESTING_DEPTH} deep`);
        }
        const element = defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
        this.checkTag(element.tagName, element.attrs, this.committed, true);
        const name = element.tagName.toLowerCase();
        if (name === "script" || name === "style") this.rawText.add(element);
        return element;
      },
      adoptAttributes: (recipient, attrs) => {
        if (recipient.attrs.length + attrs.length > MAX_HTML_ELEMENT_ATTRIBUTES) throw this.attributeLimit();
        defaultTreeAdapter.adoptAttributes(recipient, attrs);
        this.checkTag(recipient.tagName, recipient.attrs, this.committed, true);
      },
      onItemPop: (item) => {
        if (this.rawText.delete(item)) this.checkRawText(item);
      },
      // The parser inserts before a node only to move content out of a table
      // (foster parenting). The table is normally its parent's last child, so
      // it is found from the end rather than the start.
      insertBefore: (parent, node, reference) => {
        this.fosterParent();
        parent.childNodes.splice(parent.childNodes.lastIndexOf(reference), 0, node);
        node.parentNode = parent;
      },
      insertTextBefore: (parent, text, reference) => {
        const index = parent.childNodes.lastIndexOf(reference);
        const previous = parent.childNodes[index - 1];
        if (previous !== undefined && defaultTreeAdapter.isTextNode(previous)) {
          previous.value += text;
          return;
        }
        this.fosterParent();
        const node = defaultTreeAdapter.createTextNode(text);
        parent.childNodes.splice(index, 0, node);
        node.parentNode = parent;
      },
    };
    this.parser = new Parser({ treeAdapter: adapter, scriptingEnabled: scripting });
    // The tokenizer checks each new attribute against the tag's earlier ones,
    // so a tag's attribute count is capped as it is read.
    const tokenizer = this.parser.tokenizer as unknown as TokenizerInternals;
    const leaveAttributeName = tokenizer._leaveAttrName;
    if (typeof leaveAttributeName !== "function") throw new Error("parse5 no longer exposes the attribute hook the HTML check needs.");
    tokenizer._leaveAttrName = () => {
      const token = tokenizer.currentToken;
      if (token?.type === Token.TokenType.START_TAG && token.attrs.length >= MAX_HTML_ELEMENT_ATTRIBUTES) throw this.attributeLimit();
      leaveAttributeName.call(tokenizer);
    };
  }

  /** Parses the next chunk of the document. */
  write(chunk: string): void {
    if (this.finished || chunk.length === 0) return;
    this.run(() => this.parser.tokenizer.write(chunk, false));
  }

  /**
   * What the document written so far would load or run. A start tag still
   * being written is read again only while it is short or once it has doubled
   * since it was last read, so a long unfinished tag streamed in small chunks
   * costs linear time. It is read in full when it ends (or at `finish`), and
   * a browser shows no element for it before then.
   */
  findings(): HtmlFindings {
    if (this.complete() || this.committed.limit !== undefined) return { ...this.committed };
    const findings = { ...this.committed };
    const pending = (this.parser.tokenizer as unknown as TokenizerInternals).currentToken;
    if (pending?.type === Token.TokenType.START_TAG) {
      const size = pending.attrs.reduce((total, attribute) => total + attribute.name.length + attribute.value.length, pending.tagName.length);
      if (pending !== this.pending?.tag || size <= PENDING_TAG_REREAD_SIZE || size >= 2 * this.pending.size) {
        const found: HtmlFindings = {};
        this.checkTag(pending.tagName, pending.attrs, found, false);
        this.pending = { tag: pending, size, found };
      }
      findings.embed ??= this.pending.found.embed;
      findings.url ??= this.pending.found.url;
    }
    return findings;
  }

  /**
   * About how many characters the token still being read holds. parse5 keeps
   * an unfinished token's text in its input buffer and copies that buffer
   * for every chunk written, so a caller feeding many small chunks holds
   * them until they are about this long.
   */
  unfinishedSize(): number {
    if (this.finished) return 0;
    const tokenizer = this.parser.tokenizer as unknown as TokenizerInternals;
    const token = tokenizer.currentToken;
    let size = tokenizer.currentCharacterToken?.chars.length ?? 0;
    if (token?.type === Token.TokenType.START_TAG || token?.type === Token.TokenType.END_TAG) {
      // The attribute being read is in `attrs` once its name ends; before that only `currentAttr` has it.
      const attributes = token.attrs.reduce((total, attribute) => total + attribute.name.length + attribute.value.length, 0);
      size = Math.max(size, token.tagName.length + attributes + (tokenizer.currentAttr?.name.length ?? 0));
    } else if (token?.type === Token.TokenType.COMMENT) {
      size = Math.max(size, token.data.length);
    } else if (token?.type === Token.TokenType.DOCTYPE) {
      size = Math.max(size, (token.name?.length ?? 0) + (token.publicId?.length ?? 0) + (token.systemId?.length ?? 0));
    }
    return size;
  }

  /**
   * Ends the document and reports everything it would load or run. A start
   * tag left open at the end counts as written so far: the host's closing
   * markup after the visual would otherwise finish it.
   */
  finish(): HtmlFindings {
    if (!this.finished) {
      const pending = { ...this.committed };
      const tag = (this.parser.tokenizer as unknown as TokenizerInternals).currentToken;
      if (!this.complete() && this.committed.limit === undefined && tag?.type === Token.TokenType.START_TAG) {
        this.checkTag(tag.tagName, tag.attrs, pending, false);
      }
      this.run(() => this.parser.tokenizer.write("", true));
      this.finished = true;
      if (this.committed.limit === undefined) {
        for (const element of this.rawText) this.checkRawText(element);
      }
      this.rawText.clear();
      this.committed.embed ??= pending.embed;
      this.committed.url ??= pending.url;
    }
    return { ...this.committed };
  }

  /** Runs the parser; a structure limit ends the scan, leaving the parser unused. */
  private run(parse: () => void): void {
    try {
      parse();
    } catch (error) {
      if (!(error instanceof StructureLimit)) throw error;
      this.committed.limit ??= error.message;
      this.finished = true;
    }
  }

  private fosterParent(): void {
    this.fosterParented += 1;
    if (this.fosterParented > MAX_HTML_FOSTER_PARENTED) {
      throw new StructureLimit(`it moves more than ${MAX_HTML_FOSTER_PARENTED.toLocaleString("en-US")} pieces of content out of tables`);
    }
  }

  private attributeLimit(): StructureLimit {
    return new StructureLimit(`an element has more than ${MAX_HTML_ELEMENT_ATTRIBUTES} attributes`);
  }

  private complete(): boolean {
    return this.committed.embed !== undefined && this.committed.url !== undefined;
  }

  private checkTag(tagName: string, attributes: readonly Token.Attribute[], into: HtmlFindings, settled: boolean): void {
    const tag = tagName.toLowerCase();
    const names = attributes.map(attributeName);
    if (
      into.embed === undefined &&
      (EMBEDDING_TAGS.has(tag) ||
        (tag === "script" && names.some((name) => SCRIPT_SOURCE_ATTRIBUTES.has(name))) ||
        (tag === "meta" && names.includes("http-equiv")))
    ) {
      into.embed = tagText(tagName, attributes);
    }
    if (into.url !== undefined) return;
    const smilTarget =
      SMIL_ELEMENTS.has(tag) &&
      attributes.some((attribute, index) => {
        const target = attribute.value.trim().toLowerCase();
        return names[index] === "attributename" && (target === "href" || target === "xlink:href");
      });
    for (const [index, attribute] of attributes.entries()) {
      const name = names[index]!;
      if (URL_ATTRIBUTES.has(name)) {
        if (isUnsafeUrl(attribute.value) || (name === "src" && isRemoteUrl(attribute.value))) {
          into.url = attributeText(attribute);
          return;
        }
      } else if (smilTarget && SMIL_VALUE_ATTRIBUTES.has(name)) {
        if (attribute.value.split(";").some(isUnsafeUrl)) {
          into.url = attributeText(attribute);
          return;
        }
      } else if (!settled) {
        // A style or handler still being written is read once it is finished.
        continue;
      } else if (name === "style") {
        if (findCssUnsafeUrl(attribute.value) !== undefined) {
          into.url = attributeText(attribute);
          return;
        }
      } else if (name.startsWith("on")) {
        const sink = findJsSink(attribute.value, this.depth);
        if (sink.limit !== undefined) {
          into.limit ??= sink.limit;
          return;
        }
        if (sink.url !== undefined || sink.embed !== undefined) {
          into.url = attributeText(attribute);
          return;
        }
      }
    }
  }

  private checkRawText(element: Element): void {
    if (this.complete()) return;
    let text = "";
    for (const child of element.childNodes) {
      if (child.nodeName === "#text") text += (child as DefaultTreeAdapterTypes.TextNode).value;
    }
    if (text.length === 0) return;
    if (element.tagName.toLowerCase() === "script") {
      const sink = findJsSink(text, this.depth);
      this.committed.limit ??= sink.limit;
      this.committed.embed ??= sink.embed;
      this.committed.url ??= sink.url;
    } else {
      this.committed.url ??= findCssUnsafeUrl(text);
    }
  }
}

/** Scans a whole document or a string handed to an HTML sink. */
export function scanHtmlString(html: string, depth = 0): HtmlFindings {
  const scanner = new HtmlScanner(depth);
  scanner.write(html);
  return scanner.finish();
}
