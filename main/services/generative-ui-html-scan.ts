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
// such markup through an HTML sink.
//
// A sink's literal is followed however it is written:
// - the call: plain or optional (`f?.(...)`), named in brackets
//   (`o['f'](...)`), parenthesized (`(o.f)(...)`, `(0, f)(...)`), bound
//   (`f.bind(o)(...)`) or through `.call`, with its arguments shifted;
// - the argument: a tagged template (also read raw, as String.raw passes it),
//   a trivial wrapper (`(…)`, `(0, …)`, `a || …`, `a ? … : …`, an array,
//   a spread array, a template substitution), or strings joined with `+`,
//   checked alone and joined, even after a value
//   (`'<img src=x on' + 'error=…>'`);
// - the target: a bare `innerHTML =`, `href.baseVal`, an object key that
//   Object.assign copies (named, computed or `location`), an attribute
//   node's value (`attributes.onclick.value`, `getAttributeNode`,
//   `getAttributeNodeNS`, `getNamedItemNS`), DOMParser's parseFromString
//   (read as HTML for an HTML, XHTML, SVG or computed type; for an XML type
//   only if it names a namespace the page runs, and refused if it declares
//   entities), `execCommand('insertHTML', …)` and `navigation.navigate`.
// An on* attribute node made by createAttribute is refused outright, and so
// is markup or a handler a script writes more than MAX_NESTED_HTML_DEPTH
// strings deep (fail closed, not admitted unread).
//
// Not followed: names and values computed at run time, variables,
// destructuring targets, an SVG <set> whose `to` is set by setAttribute,
// `.apply` and `Reflect.apply`. The sandbox's CSP, which is what actually
// blocks loads, is the backstop there.
//
// Labels ("JavaScript: 41%"), comparisons in scripts ("i<base && i>0") and
// plain strings pass.

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
/**
 * HTML or a handler body handed to a sink is read again, at most this many
 * strings deep. One nested deeper is refused unread rather than admitted.
 */
const MAX_NESTED_HTML_DEPTH = 3;
const NESTED_HTML_LIMIT = `a script writes markup or a handler more than ${MAX_NESTED_HTML_DEPTH} strings deep`;

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
  /** A line break comes before this token. */
  lineBefore?: boolean;
}

const PUNCTUATORS = [
  ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
];
/** Reserved words after which an expression, so a regex, starts. */
const REGEX_AFTER_KEYWORDS: ReadonlySet<string> = new Set([
  "return", "typeof", "case", "do", "else", "in", "instanceof", "new", "delete", "void", "throw", "extends", "default",
]);
/** Words that are keywords in some code (generators, async functions, for-of heads) and plain names in other code. */
const CONTEXTUAL_KEYWORDS: ReadonlySet<string> = new Set(["yield", "await", "of"]);
/** Keywords whose parenthesized head is followed by a statement, where `/` starts a regex. */
const HEAD_KEYWORDS: ReadonlySet<string> = new Set(["if", "while", "for", "with"]);
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };
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
    const unicode = readUnicodeEscape(code, at + 1);
    if (unicode) return unicode;
  }
  // A legacy octal escape (`\74` is "<", `\152` is "j"): sloppy-mode strings
  // read up to three octal digits, at most two after a 4 to 7. Strict code and
  // templates refuse them, so that code never runs and reading them the same
  // way only errs toward a refusal. `\8` and `\9` are the digits themselves.
  if (char >= "0" && char <= "7") {
    const octal = char <= "3" ? /[0-7]{1,3}/uy : /[0-7]{1,2}/uy;
    octal.lastIndex = at;
    const digits = octal.exec(code)![0];
    return [String.fromCharCode(Number.parseInt(digits, 8)), at + digits.length];
  }
  return [SIMPLE_ESCAPES[char] ?? char, at + 1];
}

/**
 * Reads a `\u` escape's digits at `at` (just past the `u`): four hex digits,
 * or a braced code point with any number of leading zeros. Returns the cooked
 * text and the index after it, or undefined when the digits are malformed (a
 * syntax error).
 */
function readUnicodeEscape(code: string, at: number): [string, number] | undefined {
  if (code[at] === "{") {
    const braced = /\{0*([0-9a-f]{1,6})\}/iuy;
    braced.lastIndex = at;
    const match = braced.exec(code);
    if (!match) return undefined;
    const point = Number.parseInt(match[1]!, 16);
    return [point <= 0x10ffff ? String.fromCodePoint(point) : "", at + match[0].length];
  }
  const hex = /[0-9a-f]{4}/iuy;
  hex.lastIndex = at;
  const match = hex.exec(code);
  return match ? [String.fromCharCode(Number.parseInt(match[0], 16)), at + 4] : undefined;
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

/** `isOperandEnd` for the sink rules, which read `await` as the operator it is in async code: a value follows it, even on the next line. */
const endsOperand = (token: JsToken | undefined): boolean => isOperandEnd(token) && !(token?.kind === "name" && token.text === "await");

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
    if (this.lineBreak) token.lineBefore = true;
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
    // A private name (`#default`, `#if`) is one name token, so it never reads
    // as the keyword it spells: `this.#default/1` divides.
    const privateName = char === "#" && (IDENTIFIER_START.test(code[this.at + 1] ?? "") || code[this.at + 1] === "\\");
    if (IDENTIFIER_START.test(char) || char === "\\" || privateName) {
      // A name may spell its characters as \u escapes (`\u{6F}pen` is open),
      // so its text is the name they spell.
      let at = this.at;
      let text = "";
      while (at < code.length && (at === this.at || IDENTIFIER_PART.test(code[at]!) || code[at] === "\\")) {
        if (code[at] === "\\") {
          const unicode = code[at + 1] === "u" ? readUnicodeEscape(code, at + 2) : undefined;
          if (unicode) {
            text += unicode[0];
            at = unicode[1];
            continue;
          }
        }
        text += code[at];
        at += 1;
      }
      this.at = at;
      this.push({ kind: "name", text, start, end: at });
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
/**
 * The types DOMParser's `parseFromString` parses as HTML; the XML types and
 * any other value (which makes it throw) are read by `parseFromStringSink`.
 */
const DOM_PARSER_HTML_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml", "image/svg+xml"]);
const DOM_PARSER_XML_TYPES: ReadonlySet<string> = new Set(["text/xml", "application/xml"]);
/** How far ahead a `parseFromString(` call's type argument is looked for; past it the type counts as computed. */
const PARSE_TYPE_LOOKAHEAD = 4_096;
/**
 * XML that names the XHTML, SVG or MathML namespace, or spells a namespace
 * with a character reference.
 */
const XML_MARKUP_NAMESPACE = /www\.w3\.org\/(?:1999\/xhtml|2000\/svg|1998\/Math\/MathML)|xmlns(?::[\w.-]+)?\s*=\s*(?:"[^"&]*&|'[^'&]*&)/iu;
/** An attribute node's properties that set its value. */
const ATTRIBUTE_NODE_VALUES: ReadonlySet<string> = new Set(["value", "nodeValue", "textContent"]);
/** Assignment operators whose right side is the value written. */
const ASSIGNMENTS: ReadonlySet<string> = new Set(["=", "+=", "||=", "&&=", "??="]);

/**
 * `xml` is markup DOMParser parses as XML: its elements are HTML, SVG or
 * MathML ones only in those namespaces, so it is read as HTML only when it
 * names one of them.
 */
type SinkKind = "url" | "html" | "handler" | "xml";
/** The sinks a value reaches, each with where its target starts (for the excerpt). */
type SinkSet = Readonly<Partial<Record<SinkKind, number>>>;
const SINK_KINDS: readonly SinkKind[] = ["url", "html", "handler", "xml"];

function joinSinks(...sets: (SinkSet | undefined)[]): SinkSet | undefined {
  let joined: Partial<Record<SinkKind, number>> | undefined;
  for (const set of sets) {
    if (set === undefined) continue;
    for (const kind of SINK_KINDS) {
      if (set[kind] !== undefined && joined?.[kind] === undefined) (joined ??= {})[kind] = set[kind];
    }
  }
  return joined;
}

const sameSinks = (a: SinkSet | undefined, b: SinkSet | undefined) => SINK_KINDS.every((kind) => a?.[kind] === b?.[kind]);

/** What an attribute of this name does with its value. */
function attributeSink(name: string | undefined): SinkKind | undefined {
  if (name === undefined) return undefined;
  const lower = name.toLowerCase();
  if (URL_ATTRIBUTES.has(lower)) return "url";
  if (lower === "srcdoc") return "html";
  return lower.startsWith("on") ? "handler" : undefined;
}

interface CallFrame {
  call: boolean;
  callee?: string;
  receiver?: string;
  start: number;
  argument: number;
  /** How many leading arguments come before the callee's own: 1 for `f.call(thisArg, ...)`. */
  shift?: number;
  /** An array spread into a call's arguments (`f(...['a', b])`): its elements are the call's arguments from `argument` on. */
  spread?: boolean;
  /** For `Object.assign(target, ...)`: what the attribute node `target` reads does with a `value` key. */
  assignTo?: SinkKind;
  /**
   * The plain string value of each of the first `LITERAL_ARGUMENTS`
   * arguments that is a single literal (only those name what a call does).
   */
  literals: (string | undefined)[];
  /** For a `parseFromString(` call: how DOMParser reads its first argument (see `parseFromStringType`). */
  parseAs?: ParseAs;
  /** A `replace(...)` call's unsafe first argument, flagged only if it is the only argument. */
  deferred?: string;
  /**
   * The sinks the value being written at this level reaches, from an
   * assignment's target or an object key; cleared where that value ends (a
   * `,`, a `;` or a line break that ends the statement).
   */
  sinks?: SinkSet;
  /** The sinks the enclosing value reaches, for a value wrapped in parentheses, an array or a template substitution. */
  outer?: SinkSet;
  /** The bottom frame, for code outside every bracket. It is never popped. */
  root?: boolean;
  /**
   * For a value wrapped in parentheses or an array where the enclosing value
   * is written to a URL sink, even after a `+`: where that sink's target
   * starts, so the wrapped value's literals can continue the URL the
   * literals before them spell (`'java' + ['script:…']`).
   */
  urlTarget?: number;
}

const isLiteral = (token: JsToken | undefined): token is JsToken => token?.kind === "string" || token?.kind === "template";
const isDot = (token: JsToken | undefined) => token?.kind === "punct" && (token.text === "." || token.text === "?.");
const isPunct = (token: JsToken | undefined, text: string) => token?.kind === "punct" && token.text === text;
const isName = (token: JsToken | undefined, text: string) => token?.kind === "name" && token.text === text;

/** How many leading arguments' literal values a call frame keeps: a sink is named by its first or second. */
const LITERAL_ARGUMENTS = 2;

const rootFrame = (): CallFrame => ({ call: false, start: 0, argument: 0, literals: [], root: true });
const copyFrames = (stack: readonly CallFrame[]): CallFrame[] => stack.map((frame) => ({ ...frame, literals: [...frame.literals] }));

function sameFrame(a: CallFrame, b: CallFrame): boolean {
  return (
    a.call === b.call &&
    a.callee === b.callee &&
    a.receiver === b.receiver &&
    a.start === b.start &&
    a.argument === b.argument &&
    a.shift === b.shift &&
    a.spread === b.spread &&
    a.assignTo === b.assignTo &&
    a.deferred === b.deferred &&
    a.parseAs === b.parseAs &&
    a.root === b.root &&
    a.urlTarget === b.urlTarget &&
    sameSinks(a.sinks, b.sinks) &&
    sameSinks(a.outer, b.outer) &&
    a.literals.length === b.literals.length &&
    a.literals.every((literal, index) => literal === b.literals[index])
  );
}

/** The function or property name that the tokens ending at `at` read: `f`, `o.f`, `o?.f`, `o['f']` or `o?.['f']`. */
function memberAt(tokens: readonly JsToken[], at: number): { name: string; start: number; object?: number } | undefined {
  const last = tokens[at];
  if (last?.kind === "name") return { name: last.text, start: last.start, object: isDot(tokens[at - 1]) ? at - 2 : undefined };
  if (isPunct(last, "]") && isLiteral(tokens[at - 1]) && isPunct(tokens[at - 2], "[")) {
    const object = isPunct(tokens[at - 3], "?.") ? at - 4 : at - 3;
    const before = tokens[object];
    const read = before !== undefined && isOperandEnd(before);
    return { name: tokens[at - 1]!.value ?? "", start: (before?.kind === "name" ? before : tokens[at - 2]!).start, object: read ? object : undefined };
  }
  return undefined;
}

/** The `(` that the `)` at `at` closes, looked for at most `MATCH_LOOKBEHIND` tokens back. */
function openingParen(tokens: readonly JsToken[], at: number): number | undefined {
  let depth = 0;
  for (let index = at - 1; index >= Math.max(0, at - MATCH_LOOKBEHIND); index -= 1) {
    const token = tokens[index]!;
    if (token.kind !== "punct") continue;
    if (token.text === ")" || token.text === "]" || (token.text === "}" && token.closesTemplate !== true)) depth += 1;
    else if (token.text === "(" || token.text === "[" || token.text === "{" || token.text === "${") {
      if (depth === 0) return token.text === "(" ? index : undefined;
      depth -= 1;
    }
  }
  return undefined;
}
const MATCH_LOOKBEHIND = 64;

/** Whether the brackets from `open` to `close` hold a `,` of their own. */
function holdsComma(tokens: readonly JsToken[], open: number, close: number): boolean {
  let depth = 0;
  for (let index = open + 1; index < close; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "punct") continue;
    if (token.text === "(" || token.text === "[" || token.text === "{" || token.text === "${") depth += 1;
    else if (token.text === ")" || token.text === "]" || token.text === "}") depth -= 1;
    else if (token.text === "," && depth === 0) return true;
  }
  return false;
}

/** Functions whose arguments `f.call(thisArg, ...)` passes on to a sink. */
const isSinkFunction = (name: string) =>
  name === "setAttribute" ||
  name === "setAttributeNS" ||
  name === "open" ||
  name === "assign" ||
  name === "replace" ||
  name === "navigate" ||
  name === "execCommand" ||
  name === "parseFromString" ||
  Object.prototype.hasOwnProperty.call(HTML_CALLS, name);

interface Callee {
  callee: string;
  receiver?: string;
  start: number;
  /** How many leading arguments come before the callee's own (see `CallFrame.shift`). */
  shift?: number;
}

/**
 * The function a call or tagged template names, where `at` is the token just
 * before its `(` or template: `f`, `o.f`, `o?.f`, `o['f']` or `o?.['f']`, any
 * of them followed by `?.`, wrapped in parentheses (`(o.f)`, `(0, f)`), bound
 * (`o.f.bind(o)`) or called through `.call` (`o.f.call(o, ...)`, whose
 * arguments after the first are f's). A keyword (`return (`, `typeof (`)
 * names none, and neither does another call's result.
 */
function calleeBefore(tokens: readonly JsToken[], at: number, hops = 0): Callee | undefined {
  const index = isPunct(tokens[at], "?.") ? at - 1 : at;
  const last = tokens[index];
  if (isPunct(last, ")")) {
    if (last.closesHead === true || hops >= 2) return undefined;
    const open = openingParen(tokens, index);
    if (open === undefined) return undefined;
    const bound = memberAt(tokens, open - 1);
    if (bound?.name === "bind" && bound.object !== undefined) {
      return holdsComma(tokens, open, index) ? undefined : calleeBefore(tokens, bound.object, hops + 1);
    }
    // A call's result names no function; parentheses (or a comma expression
    // in them) name the function their last value is.
    if (isOperandEnd(tokens[open - 1])) return undefined;
    return calleeBefore(tokens, index - 1, hops + 1);
  }
  if (last?.kind === "name" && !isDot(tokens[index - 1]) && (REGEX_AFTER_KEYWORDS.has(last.text) || CONTEXTUAL_KEYWORDS.has(last.text))) return undefined;
  const member = memberAt(tokens, index);
  if (member === undefined) return undefined;
  const object = member.object === undefined ? undefined : tokens[member.object];
  const named: Callee = { callee: member.name, receiver: object?.kind === "name" ? object.text : undefined, start: member.start };
  if (member.name === "call" && member.object !== undefined && hops < 2) {
    const target = calleeBefore(tokens, member.object, hops + 1);
    if (target !== undefined && isSinkFunction(target.callee)) return { ...target, shift: (target.shift ?? 0) + 1 };
  }
  return named;
}

/** How DOMParser reads a `parseFromString` call's markup: as HTML, as XML, or not at all (it throws). */
type ParseAs = "html" | "xml" | "none";

/**
 * How the `parseFromString(` call whose `(` is at `open` reads its first
 * argument, from its second: a literal type picks HTML, XML or neither (no
 * type, or one DOMParser does not know, throws); a computed one, or one not
 * found within `PARSE_TYPE_LOOKAHEAD` tokens, may be text/html.
 */
function parseFromStringType(tokens: readonly JsToken[], open: number, skip = 0): ParseAs {
  let depth = 0;
  let commas = 0;
  const last = Math.min(tokens.length, open + PARSE_TYPE_LOOKAHEAD);
  for (let index = open + 1; index < last; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "punct") continue;
    // A spread argument can supply the type from any position, so its type is unknown.
    if (token.text === "..." && depth === 0) return "html";
    if (token.text === "(" || token.text === "[" || token.text === "{" || token.text === "${") depth += 1;
    else if (token.text === ")" || token.text === "]" || token.text === "}") {
      if (depth === 0) return "none";
      depth -= 1;
    } else if (token.text === "," && depth === 0) {
      if (commas < skip) {
        commas += 1;
        continue;
      }
      const type = tokens[index + 1];
      if (isPunct(type, ")")) return "none";
      const after = tokens[index + 2];
      if (!isLiteral(type) || type.substituted === true || !(isPunct(after, ")") || isPunct(after, ","))) return "html";
      const value = type.value ?? "";
      return DOM_PARSER_HTML_TYPES.has(value) ? "html" : DOM_PARSER_XML_TYPES.has(value) ? "xml" : "none";
    }
  }
  return "html";
}

/** A call frame's current argument, counted among the callee's own (-1 for `.call`'s `this`). */
const argumentOf = (frame: Pick<CallFrame, "argument" | "shift">) => frame.argument - (frame.shift ?? 0);

/** The sinks a call's current argument reaches. */
function argumentSinks(frame: Pick<CallFrame, "callee" | "receiver" | "start" | "argument" | "shift" | "literals" | "parseAs">): SinkSet | undefined {
  const { callee, start } = frame;
  const argument = argumentOf(frame);
  if (callee === undefined || argument < 0) return undefined;
  // `setAttribute(name, value)` or `setAttributeNS(namespace, name, value)`.
  // Only a literal name is known; a computed one is no more checked than any
  // computed property.
  if (callee === "setAttribute" || callee === "setAttributeNS") {
    const nameArgument = callee === "setAttributeNS" ? 1 : 0;
    const kind = argument === nameArgument + 1 ? attributeSink(frame.literals[nameArgument]) : undefined;
    return kind === undefined ? undefined : { [kind]: start };
  }
  if ((callee === "open" || callee === "assign") && argument === 0) return { url: start };
  if (callee === "replace" && argument === 0 && frame.receiver === "location") return { url: start };
  if (callee === "navigate" && argument === 0 && frame.receiver === "navigation") return { url: start };
  // `execCommand('insertHTML', ui, markup)` inserts markup where the selection is.
  if (callee === "execCommand" && argument === 2 && frame.literals[0]?.toLowerCase() === "inserthtml") return { html: start };
  // DOMParser's document is not in the page, but its nodes are moved into it.
  if (callee === "parseFromString" && argument === 0) {
    const as = frame.parseAs ?? "html";
    return as === "none" ? undefined : { [as]: start };
  }
  if (Object.prototype.hasOwnProperty.call(HTML_CALLS, callee)) {
    const at = HTML_CALLS[callee];
    if (at === "any" || at === argument) return { html: start };
  }
  return undefined;
}

/** Whether the tokens ending at `at` read an element's `attributes` (`.attributes` or `['attributes']`). */
const readsAttributes = (tokens: readonly JsToken[], at: number) =>
  isName(tokens[at], "attributes") || (isPunct(tokens[at], "]") && tokens[at - 1]?.value === "attributes" && isLiteral(tokens[at - 1]) && isPunct(tokens[at - 2], "["));

/**
 * The name of the attribute node that the tokens ending at `at` read:
 * `attributes.onclick`, `attributes['onclick']`, `getAttributeNode('onclick')`,
 * `getNamedItem('onclick')`, or `getAttributeNodeNS(ns, 'onclick')` and
 * `getNamedItemNS(ns, 'onclick')` with a namespace that is one token.
 */
function attributeNodeName(tokens: readonly JsToken[], at: number): string | undefined {
  const last = tokens[at];
  if (last?.kind === "name") return isDot(tokens[at - 1]) && readsAttributes(tokens, at - 2) ? last.text : undefined;
  const literal = tokens[at - 1];
  if (!isLiteral(literal)) return undefined;
  if (isPunct(last, "]") && isPunct(tokens[at - 2], "[")) return readsAttributes(tokens, at - (isPunct(tokens[at - 3], "?.") ? 4 : 3)) ? literal.value : undefined;
  if (!isPunct(last, ")")) return undefined;
  if (isPunct(tokens[at - 2], "(")) {
    const getter = tokens[at - 3];
    return isName(getter, "getAttributeNode") || isName(getter, "getNamedItem") ? literal.value : undefined;
  }
  if (isPunct(tokens[at - 2], ",") && isPunct(tokens[at - 4], "(")) {
    const getter = tokens[at - 5];
    return isName(getter, "getAttributeNodeNS") || isName(getter, "getNamedItemNS") ? literal.value : undefined;
  }
  return undefined;
}

/** The sinks the target of the assignment operator at `at` reaches. */
function assignmentSinks(tokens: readonly JsToken[], at: number): SinkSet | undefined {
  const target = tokens[at - 1];
  let property: string | undefined;
  let viaDot = false;
  let start: number;
  /** The last token of what the property is read from. */
  let object: number;
  if (target?.kind === "name") {
    property = target.text;
    viaDot = isDot(tokens[at - 2]);
    start = (viaDot ? tokens[at - 3] : target)?.start ?? target.start;
    object = at - 3;
  } else if (isPunct(target, "]") && isLiteral(tokens[at - 2]) && isPunct(tokens[at - 3], "[")) {
    property = tokens[at - 2]!.value;
    viaDot = true;
    start = tokens[at - 4]?.start ?? tokens[at - 3]!.start;
    object = isPunct(tokens[at - 4], "?.") ? at - 5 : at - 4;
  } else return undefined;
  if (property === undefined) return undefined;
  if (property === "location" || (viaDot && URL_PROPERTIES.has(property))) return { url: start };
  // A bare `innerHTML =` sets the property in a `with` block or an inline
  // handler, whose scope holds the element.
  if (HTML_PROPERTIES.has(property)) return { html: start };
  if (!viaDot) return undefined;
  // An SVG link's `href.baseVal`.
  if (property === "baseVal" && memberAt(tokens, object)?.name === "href" && memberAt(tokens, object)?.object !== undefined) return { url: start };
  if (ATTRIBUTE_NODE_VALUES.has(property)) {
    const kind = attributeSink(attributeNodeName(tokens, object));
    if (kind !== undefined) return { [kind]: start };
  }
  return undefined;
}

/** The sinks a literal in `frame` reaches: its own target's, its call argument's and the enclosing value's. */
const frameSinks = (frame: CallFrame) => joinSinks(frame.sinks, frame.call ? argumentSinks(frame) : undefined, frame.outer);

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
 * A place that reads two ways (see `JsLexer`) is checked both ways. `code` is
 * a whole script or an event handler's body; either may start with a hashbang.
 */
export function findJsSink(code: string, depth = 0): HtmlFindings {
  const lexer = new JsLexer(code, { at: hashbangEnd(code), braces: undefined, parens: undefined, tail: [], lineBreak: false });
  lexer.run();
  const tokens = lexer.tokens;
  let found: HtmlFindings = {};
  const note = (findings: HtmlFindings) => {
    found = { embed: found.embed ?? findings.embed, url: found.url ?? findings.url, limit: found.limit ?? findings.limit };
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
  const stack: CallFrame[] = [rootFrame()];
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
    // The root frame is never popped: when only it differs, this reading
    // has nothing left to add once its value has ended.
    const caughtUp = () => frames.length <= level || (level === 0 && frames.length === 1 && frames[0]!.sinks === undefined);
    scanJsTokens(code, tokens, other.meet, frames, depth, note, () => done() || caughtUp(), () => spend(1));
  });
  return found;
}

/**
 * Where a hashbang comment ends, or 0 without one. A `#!` at the very start of
 * a classic or module script reads as a line comment, and so does one at the
 * start of an event handler: the browser compiles a handler's body as a
 * function's source text (V8's CompileFunction), whose first two characters
 * may be a hashbang too. Anywhere else it is a syntax error, so that code
 * never runs and needs no such reading. A byte order mark before it is skipped
 * too: an engine that kept the mark would refuse the code instead.
 */
function hashbangEnd(code: string): number {
  const start = code.startsWith("\uFEFF") ? 1 : 0;
  if (!code.startsWith("#!", start)) return 0;
  let at = start + 2;
  while (at < code.length && !LINE_BREAK.test(code[at]!)) at += 1;
  return at;
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
  const checkMarkup = (markup: string) => {
    if (!markup.includes("<")) return;
    if (depth >= MAX_NESTED_HTML_DEPTH) note({ limit: NESTED_HTML_LIMIT });
    else note(scanHtmlString(markup, depth + 1));
  };
  // An on* attribute's value is a handler's body, checked as one. Past the
  // depth cap a handler that holds a string could write anything, so it is
  // refused unread; one without a string or template has no literal to hand
  // a sink.
  const checkHandler = (body: string, excerpt: string) => {
    if (depth >= MAX_NESTED_HTML_DEPTH) {
      if (/["'`]/u.test(body)) note({ limit: NESTED_HTML_LIMIT });
      return;
    }
    const handler = findJsSink(body, depth + 1);
    // A handler too complex to read is refused as that, not as a URL it may not send.
    if (handler.limit !== undefined) note({ limit: handler.limit });
    else if (handler.url !== undefined || handler.embed !== undefined) note({ url: excerpt });
  };

  // XML a page takes nodes from: only an element in the XHTML, SVG or
  // MathML namespace is one the page runs or loads, so XML that declares
  // none (an RSS feed, a config file) is safe. XML that declares one is read
  // as HTML with its element prefixes dropped (`<x:iframe>` is an iframe);
  // XML that declares entities, which can spell any of that, is refused.
  const checkXml = (markup: string) => {
    if (/<!ENTITY/iu.test(markup)) note({ limit: "a script parses XML that declares entities" });
    else if (XML_MARKUP_NAMESPACE.test(markup)) checkMarkup(markup.replace(/<(\/?)[A-Za-z_][\w.-]*:/gu, "<$1"));
  };

  /**
   * The URL the literals written to one URL sink spell, by where its target
   * starts, while each literal follows the one before with only a `+` and
   * brackets between them (`'java' + ('script') + ':…'`). It is open only
   * from a literal where the URL starts: one after a value and a `+` (`base
   * + 'javascript:…'`) is not.
   */
  const urlPieces = new Map<number, { url: string; open: boolean; last: number }>();

  /** The literals each markup, handler or XML sink is given, by kind and where its target starts. */
  const values = new Map<string, { kind: "html" | "handler" | "xml"; start: number; end: number; parts: string[] }>();
  const collect = (kind: "html" | "handler" | "xml", start: number, part: string, end: number) => {
    const key = `${kind}:${start}`;
    const value = values.get(key);
    if (value === undefined) values.set(key, { kind, start, end, parts: [part] });
    else {
      value.parts.push(part);
      value.end = end;
    }
  };

  for (let index = from; index < tokens.length && !done(); index += 1) {
    visit?.(index);
    const token = tokens[index]!;
    const previous = tokens[index - 1];
    let frame = stack[stack.length - 1]!;
    // A line break between a finished operand and a name or string ends the
    // statement (no `+`, `.` or `(` carries it on), and with it the value.
    if (token.lineBefore === true && endsOperand(previous) && ((token.kind === "name" && !OPERATOR_WORDS.has(token.text)) || token.kind === "string")) {
      frame.sinks = undefined;
    }
    if (token.kind === "punct") {
      const text = token.text;
      if (text === "(") {
        const named = calleeBefore(tokens, index - 1);
        const call = named !== undefined || isPunct(previous, ")") || isPunct(previous, "]") || isPunct(previous, "?.");
        stack.push({
          call,
          callee: named?.callee,
          receiver: named?.receiver,
          start: named?.start ?? token.start,
          argument: 0,
          shift: named?.shift,
          literals: [],
          parseAs: named?.callee === "parseFromString" ? parseFromStringType(tokens, index, named.shift) : undefined,
          outer: call ? undefined : wrappedSinks(frame, previous),
          urlTarget: call ? undefined : wrappedUrlTarget(frame),
        });
      } else if (text === "[" && isPunct(previous, "...") && frame.call && frame.callee !== undefined) {
        // An array spread into a call: its elements are the call's arguments.
        stack.push({ ...frame, literals: [...frame.literals], spread: true, sinks: undefined, deferred: undefined });
      } else if (text === "[" || text === "${") {
        // `[` after an operand reads a property; only an array literal is the value.
        const value = text === "${" || !endsOperand(previous);
        const array = text === "[" && value;
        stack.push({
          call: false,
          start: token.start,
          argument: 0,
          literals: [],
          outer: value ? wrappedSinks(frame, previous) : undefined,
          urlTarget: array ? wrappedUrlTarget(frame) : undefined,
        });
      } else if (text === "{") {
        stack.push({ call: false, start: token.start, argument: 0, literals: [] });
      } else if (text === ",") {
        // `Object.assign(node, {value: ...})` sets an attribute node's value.
        if (frame.callee === "assign" && frame.receiver === "Object" && frame.argument === 0) frame.assignTo = attributeSink(attributeNodeName(tokens, index - 1));
        if (frame.root !== true) frame.argument += 1;
        frame.sinks = undefined;
      } else if (text === ";") {
        frame.sinks = undefined;
      } else if (ASSIGNMENTS.has(text)) {
        frame.sinks = joinSinks(frame.sinks, assignmentSinks(tokens, index));
      } else if (text === ":") {
        // An object key whose value the object then writes, as in
        // `Object.assign(element, {innerHTML: ...})`, named or computed from a
        // literal (`{['innerHTML']: ...}`).
        const computed = isPunct(tokens[index - 1], "]") && isLiteral(tokens[index - 2]) && isPunct(tokens[index - 3], "[");
        const key = computed ? tokens[index - 2] : tokens[index - 1];
        const keyName = key?.kind === "name" ? key.text : isLiteral(key) ? key.value : undefined;
        const before = tokens[index - (computed ? 4 : 2)];
        if (keyName !== undefined && (isPunct(before, "{") || isPunct(before, ","))) {
          const assigned = stack[stack.length - 2];
          if (URL_PROPERTIES.has(keyName) || keyName === "location") frame.sinks = { url: key!.start };
          else if (HTML_PROPERTIES.has(keyName)) frame.sinks = { html: key!.start };
          else if (ATTRIBUTE_NODE_VALUES.has(keyName) && assigned?.assignTo !== undefined && assigned.argument > 0) frame.sinks = { [assigned.assignTo]: key!.start };
        }
      } else if (text === ")" || text === "]" || text === "}") {
        if (frame.root === true) frame.sinks = undefined;
        else if (frame.spread === true) {
          stack.pop();
          const call = stack[stack.length - 1]!;
          // The array's last element is the call's current argument; an
          // empty array adds none, and a trailing comma ends no element.
          call.argument = isPunct(previous, "[") || isPunct(previous, ",") ? frame.argument - 1 : frame.argument;
          call.literals = frame.literals;
          call.deferred ??= frame.deferred;
        } else {
          stack.pop();
          if (frame.deferred !== undefined && argumentOf(frame) === 0) note({ url: code.slice(frame.start, token.end) });
          // An on* attribute node made to be set on an element later: its
          // value is not followed, so the attribute is refused.
          const name = frame.callee === "createAttribute" ? frame.literals[0] : frame.callee === "createAttributeNS" ? frame.literals[1] : undefined;
          if (attributeSink(name) === "handler") note({ url: code.slice(frame.start, token.end) });
        }
      }
      continue;
    }
    if (!isLiteral(token)) continue;
    // A literal after a value joined with `+` is checked too, though not as
    // where a URL starts.
    const afterPlus = isPunct(previous, "+");

    // A chain of literals joined by `+`, read as one value.
    let chainEnd = index;
    let { url, open: urlOpen } = literalUrl(code, tokens, index);
    let markup = token.kind === "template" ? (token.parts ?? "") : (token.value ?? "");
    while (isPunct(tokens[chainEnd + 1], "+") && isLiteral(tokens[chainEnd + 2])) {
      const next = tokens[chainEnd + 2]!;
      if (urlOpen && url.length < URL_PREFIX_LENGTH) {
        const more = literalUrl(code, tokens, chainEnd + 2);
        url += more.url;
        urlOpen = more.open;
      }
      markup += next.kind === "template" ? (next.parts ?? "") : (next.value ?? "");
      chainEnd += 2;
    }
    const end = tokens[chainEnd]!.end;
    frame = stack[stack.length - 1]!;

    if (frame.call && (isPunct(previous, "(") || isPunct(previous, ",") || (frame.spread === true && isPunct(previous, "[")))) {
      const argument = argumentOf(frame);
      if (argument >= 0 && argument < LITERAL_ARGUMENTS && chainEnd === index && (token.kind === "string" || !token.substituted)) frame.literals[argument] = token.value;
      if (frame.callee === "replace" && argument === 0 && frame.receiver !== "location" && isUnsafeUrl(url)) frame.deferred = url;
    }
    // A tagged template is a call of its tag with the template's text, which
    // String.raw (and any other tag) may pass on raw.
    let tag: SinkSet | undefined;
    let raw: string | undefined;
    if (token.kind === "template" && (previous?.kind === "name" || isPunct(previous, "]") || isPunct(previous, ")"))) {
      const named = calleeBefore(tokens, index - 1);
      if (named !== undefined || previous.kind !== "name") {
        // A tag gets the template's strings first and its substitutions after,
        // so a tagged `parseFromString` is given a type only by a substitution.
        if (named !== undefined) tag = argumentSinks({ ...named, argument: 0, literals: [], parseAs: token.substituted === true ? "html" : "none" });
        if (!token.substituted && chainEnd === index) raw = code.slice(token.start + 1, token.end - 1);
      }
    }
    let sinks = joinSinks(frameSinks(frame), tag);
    const urlTarget = sinks?.url ?? frame.urlTarget;
    if (urlTarget !== undefined) {
      const piece = urlPieces.get(urlTarget);
      if (piece === undefined) urlPieces.set(urlTarget, { url, open: sinks?.url !== undefined && !afterPlus && urlOpen, last: chainEnd });
      else {
        if (piece.open && piece.url.length < URL_PREFIX_LENGTH) {
          const joins = joinsUrlPieces(tokens, piece.last, index);
          piece.open = joins && urlOpen;
          if (joins) {
            piece.url += url;
            if (isUnsafeUrl(piece.url)) note({ url: code.slice(urlTarget, end) });
          }
        }
        piece.last = chainEnd;
      }
    }
    if (afterPlus && sinks?.url !== undefined) sinks = joinSinks({ html: sinks.html, handler: sinks.handler, xml: sinks.xml });
    if (sinks === undefined) {
      index = chainEnd;
      continue;
    }
    if (sinks.url !== undefined) {
      if (isUnsafeUrl(url) || (raw !== undefined && isUnsafeUrl(raw))) note({ url: code.slice(sinks.url, end) });
    }
    if (sinks.html !== undefined) {
      checkMarkup(markup);
      if (raw !== undefined && raw !== markup) checkMarkup(raw);
      collect("html", sinks.html, markup, end);
    }
    if (sinks.handler !== undefined) {
      checkHandler(markup, code.slice(sinks.handler, end));
      if (raw !== undefined && raw !== markup) checkHandler(raw, code.slice(sinks.handler, end));
      collect("handler", sinks.handler, markup, end);
    }
    if (sinks.xml !== undefined) {
      checkXml(markup);
      if (raw !== undefined && raw !== markup) checkXml(raw);
      collect("xml", sinks.xml, markup, end);
    }
    index = chainEnd;
  }

  // The literals one markup or handler sink is given, joined, as a value
  // that puts them together spells (`'<ifr' + ('ame …')`, `'<p>' + name +
  // '</p><iframe …>'`); what lies between them is not known.
  for (const value of values.values()) {
    if (value.parts.length < 2) continue;
    const joined = value.parts.join("");
    if (value.kind === "html") checkMarkup(joined);
    else if (value.kind === "handler") checkHandler(joined, code.slice(value.start, value.end));
    else checkXml(joined);
  }
}

/** How much of a URL is read to tell whether it is unsafe. */
const URL_PREFIX_LENGTH = 64;

/**
 * The start of the URL the literal at `at` spells, and whether the literal
 * goes on past it (no substitution cut it short). A template's text is read
 * with each substitution that is a single literal filled in, up to the first
 * one that is not.
 */
function literalUrl(code: string, tokens: readonly JsToken[], at: number): { url: string; open: boolean } {
  const token = tokens[at]!;
  if (token.kind === "string" || token.substituted !== true) return { url: token.value ?? "", open: true };
  let url = "";
  let from = token.start + 1;
  for (let index = at + 1; url.length < URL_PREFIX_LENGTH; index += 3) {
    const dollar = tokens[index];
    if (!isPunct(dollar, "${")) return { url, open: false };
    url += cookTemplateText(code, from, dollar.start);
    const literal = tokens[index + 1];
    const close = tokens[index + 2];
    if (!isLiteral(literal) || literal.substituted === true || !isPunct(close, "}")) return { url, open: false };
    url += literal.value ?? "";
    from = close.end;
    if (close.closesTemplate === true) return { url: url + cookTemplateText(code, from, Math.max(from, token.end - 1)), open: true };
  }
  return { url, open: true };
}

/** A template's text between `from` and `to`, its escapes read, up to `URL_PREFIX_LENGTH` characters. */
function cookTemplateText(code: string, from: number, to: number): string {
  let text = "";
  let at = from;
  while (at < to && text.length < URL_PREFIX_LENGTH) {
    if (code[at] === "\\") {
      const [cooked, next] = readEscape(code, at + 1);
      text += cooked;
      at = next;
    } else {
      text += code[at];
      at += 1;
    }
  }
  return text;
}

/**
 * The sinks a value wrapped in a bracket opened in `frame` after `previous`
 * reaches. After a `+` the wrapped value is not where a URL starts (though
 * it may continue one, see `urlPieces`).
 */
function wrappedSinks(frame: CallFrame, previous: JsToken | undefined): SinkSet | undefined {
  const sinks = frameSinks(frame);
  if (sinks?.url === undefined || !isPunct(previous, "+")) return sinks;
  return joinSinks({ html: sinks.html, handler: sinks.handler, xml: sinks.xml });
}

/** Where the URL sink's target that a value wrapped in a bracket opened in `frame` is part of starts. */
const wrappedUrlTarget = (frame: CallFrame) => frameSinks(frame)?.url ?? frame.urlTarget;

/** How many tokens may come between two literals that spell one URL. */
const URL_PIECE_GAP = 16;

/**
 * Whether the tokens between the literals ending at `last` and starting at
 * `next` only join them: a single `+` and the brackets around them, as in
 * `('java') + 'script:…'` or `'java' + ['script:…']`.
 */
function joinsUrlPieces(tokens: readonly JsToken[], last: number, next: number): boolean {
  if (next - last - 1 > URL_PIECE_GAP) return false;
  let pluses = 0;
  for (let index = last + 1; index < next; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "punct" || !["+", "(", ")", "[", "]"].includes(token.text)) return false;
    if (token.text === "+") pluses += 1;
  }
  return pluses === 1;
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
