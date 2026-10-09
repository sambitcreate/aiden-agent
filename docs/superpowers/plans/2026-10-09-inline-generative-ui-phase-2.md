# Inline Generative UI Phase 2: Aiden UI Catalog (desktop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the model compose visuals from Aiden's own native React components through a new `render_ui` tool. The visuals render inline in desktop chats, interact locally without model calls, stream as drafts, and persist on the message.

**Architecture:**
- A pure-TypeScript compiler in `renderer/shared/aiden-ui/` turns tolerant JSX-like "Aiden UI Markup" (AUM) into a normalized, size-capped tree. Expressions are a JSON AST and never JS.
- The tree is interpreted by a fixed evaluator. Main compiles in the `render_ui` tool, persists `ChatUiVisualV1` on the assistant message (a new sibling field, `uiVisuals`), and streams draft trees.
- The renderer draws trees with `AidenUiBlock`, built from shared primitives in `renderer/components/ui.tsx` and new sibling primitives, placed after the tool's activity row exactly like Phase 1 HTML visuals.

**Tech Stack:** TypeScript, React 19, Tailwind v4 tokens, `radix-ui` 1.6 (Tabs, Checkbox, Slider, Progress, Collapsible, Tooltip, ToggleGroup are already installed), Chart.js 4 (lazy chunk), KaTeX (lazy, already used by Markdown), node:test with `tsx`, happy-dom with Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-08-inline-generative-ui-design.md` (§5, §7, §8 Tier A, §10 CLI and onboarding, §11 invariant 5 and 6, §12 Phase 2). Phase 1 plan: `docs/superpowers/plans/2026-10-08-inline-generative-ui-phase-1.md`.

## Global Constraints

- Limits (spec §5.2): 2,000 nodes, depth 24, 64 KiB of data per visual, 256 KiB of serialized tree, 8 visuals per response, 60 per chat. `<Each>` is capped at 500 iterations.
- Expressions: path lookup, literal, `+` concatenation, comparison, ternary, `!`/`&&`/`||`, and the fixed function set `fmt(value,"currency"|"percent"|"number"|"date")`, `len`, `sum`, `max`, `min`, `round`, `filter(list,"field",value)`, `sort(list,"field","asc"|"desc")`. No loops, assignments or user-defined functions (§5.1, invariant 5).
- Actions: `sendPrompt(expr)`, `setState("key", expr)`, `openUrl("https://…")` (https only, always confirmed, invariant 6), `copy(expr)`.
- **Wire-safe key names.** No key in the persisted visual (tree, props, expression AST) may be `path`, `prompt`, `result(s)`, `token`, `args`/`argument(s)`, `header(s)`, `endpoint`, `instructions`, `reasoning`, `credential(s)`, `secret(s)`, or a `child`/`children`/`subagent` compound. Shipped iOS and Android validators and old desktop builds reject a whole chat that contains them (see Phase 3).
  - Prop names that would collide are renamed in the catalog. For example `Image` uses `attachment`, not `path`.
  - The model-authored `<Data>` JSON is stored as a string (`dataJson`), so its keys are never wire keys.
- Downgrade safety (§13): `ChatHtmlArtifactV1` and `HtmlArtifactPlacementV1` keep their shapes. Tier A lives only in the new message field `uiVisuals`, parsed leniently per entry.
- Design rules (AGENTS.md, `docs/design-guide.md`):
  - Use the shared squircle `Button`, borderless surfaces, and status in soft semantic fills.
  - `--chart-1…8` are for series and never status colors.
  - Non-text controls keep the neutral focus ring; text inputs get no focus ring.
  - Use `AidenActivityMark` for activity.
  - No brain icons, and no decorative borders on radio cards.
- Tests (AGENTS.md):
  - Write behavioral tests only. No source-grep, tautological, or change-detector tests.
  - Register new test files in `package.json` scripts (here, `test:generative-ui`) and keep `npm run test:ci-policy` green.
- Network posture: render_ui never fetches anything. `Image` resolves only message or workspace attachments by id.

## Review Focus

1. **Truncated or garbage markup mid-stream** (a cut inside an attribute, an expression, or a `<Data>` body) must yield a partial tree plus diagnostics, never a throw or a blank draft. Test: Task 2 streaming-prefix vectors.
2. **Hostile data** (prototype keys `__proto__`/`constructor` in `<Data>`, 10,000-row arrays, deep nesting, huge strings) must never pollute objects, hang the evaluator, or exceed caps. Test: Task 3 evaluator caps and prototype-key vectors.
3. **A model that writes HTML-ish or React-ish markup** (`<div>`, `className=`, `onClick=`, `{items.map(...)}`) must get dropped nodes and clear diagnostics back in the tool result, not a crash or silent empty visual. Test: Task 4 compile vectors, Task 7 tool-result diagnostics.
4. **Switching the theme or chat width while a visual is mounted** must restyle it live, with no remount that loses local state. Test: Task 6 render test with a theme flip.
5. **A visual whose action sends a follow-up while a reply is running** must stage the text in the composer like Phase 1, never interrupt the run. Test: Task 9 message-list test.

---

## File Structure

| File | Responsibility |
|---|---|
| `renderer/shared/aiden-ui/types.ts` | `AidenUiExprV1`, `AidenUiActionV1`, `AidenUiNodeV1`, `ChatUiVisualV1`, diagnostics, limits |
| `renderer/shared/aiden-ui/parse.ts` | Tolerant AUM tokenizer and parser → AST plus recovery diagnostics |
| `renderer/shared/aiden-ui/expression.ts` | Expression source parser → `AidenUiExprV1` |
| `renderer/shared/aiden-ui/catalog.ts` | Component catalog: prop schemas, child policy, wire-safe names |
| `renderer/shared/aiden-ui/compile.ts` | AST → normalized tree, data extraction, validation, limits, fallback text |
| `renderer/shared/aiden-ui/evaluate.ts` | Pure evaluator with caps; scope = data, state, Each locals |
| `renderer/shared/aiden-ui/fallback-text.ts` | Tree → Markdown-ish plain text for memory, CLI, mobile |
| `renderer/shared/aiden-ui/visual.ts` | `parseChatUiVisuals` (lenient), `parseChatUiVisualV1`, size checks |
| `renderer/shared/aiden-ui/fixtures/*.aum` | Representative markup corpus used by tests (and the eval script) |
| `renderer/components/ui-primitives.tsx` | New shared primitives: `Tabs`, `Segmented`, `Checkbox`, `Slider`, `Progress`, `Tooltip`, `Disclosure`, `Kbd`, `Stat`, `DataTable` |
| `renderer/components/aiden-ui/aiden-ui-block.tsx` | Renders a `ChatUiVisualV1`: state, scope, actions, caption row |
| `renderer/components/aiden-ui/components.tsx` | Catalog name → React component map |
| `renderer/components/aiden-ui/chart.tsx` | Lazy Chart.js chart, `BarList`, `Sparkline`, `Heatmap` |
| `main/services/aiden-ui-extension.ts` | `render_ui` tool plus `ui` / `ui_draft` events plumbing callback |
| `main/services/aiden-ui-draft.ts` | Draft session for streaming `markup` → compiled tree events |
| `scripts/eval-aiden-ui.mjs` | Optional live model eval (not in CI) |

---

### Task 1: Shared types and the lenient visual parser

**Files:**
- Create: `renderer/shared/aiden-ui/types.ts`, `renderer/shared/aiden-ui/visual.ts`
- Test: `renderer/shared/aiden-ui/visual.test.ts`

**Interfaces:**
- Produces:
```ts
export const AIDEN_UI_CATALOG_VERSION = 1;
export const AIDEN_UI_LIMITS = { nodes: 2000, depth: 24, dataBytes: 64 * 1024, treeBytes: 256 * 1024, perResponse: 8, perChat: 60, eachIterations: 500, stateBytes: 4096, fallbackChars: 4000 } as const;
export type AidenUiExprV1 =
  | { op: "lit"; v: string | number | boolean | null }
  | { op: "var"; name: string }                              // $name → data binding or state key
  | { op: "get"; of: AidenUiExprV1; key: AidenUiExprV1 }     // a.b / a[b]
  | { op: "bin"; o: "+" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||"; l: AidenUiExprV1; r: AidenUiExprV1 }
  | { op: "not"; e: AidenUiExprV1 }
  | { op: "if"; test: AidenUiExprV1; then: AidenUiExprV1; else: AidenUiExprV1 }
  | { op: "call"; fn: "fmt" | "len" | "sum" | "max" | "min" | "round" | "filter" | "sort"; a: AidenUiExprV1[] }
  | { op: "json"; v: unknown };                               // literal object/array prop
export type AidenUiActionV1 =
  | { act: "send"; text: AidenUiExprV1 }
  | { act: "set"; key: string; value: AidenUiExprV1 }
  | { act: "open"; url: AidenUiExprV1 }
  | { act: "copy"; text: AidenUiExprV1 };
export interface AidenUiNodeV1 { t: string; k: string; p?: Record<string, AidenUiExprV1 | AidenUiActionV1>; c?: AidenUiNodeV1[]; s?: string /* text */; e?: AidenUiExprV1 /* {expr} child */ }
export interface ChatUiVisualV1 {
  version: 1; kind: "ui"; id: string; toolCallId?: string; title: string;
  catalogVersion: number; tree: AidenUiNodeV1; dataJson?: string; state?: Record<string, unknown>;
  fallbackText: string; layout?: "wide";
}
export interface AidenUiDiagnostic { code: "unknown_element" | "unknown_prop" | "invalid_literal" | "invalid_expression" | "limit" | "recovered" | "data_invalid" | "bad_child"; message: string; at?: string }
```
  - `parseChatUiVisuals(value: unknown): ChatUiVisualV1[] | undefined` drops invalid entries individually and ignores unknown keys.
  - `isWireSafeKey(name: string): boolean` normalizes by stripping `-_.` and whitespace, then lowercasing, and rejects the forbidden set.

- [ ] **Step 1: Write the failing test.** Test file `visual.test.ts`:
  - A valid visual round-trips.
  - An entry missing `tree` is dropped while its neighbor survives.
  - An unknown top-level key is ignored.
  - `isWireSafeKey` rejects `"Path"`, `"tool_args"`, `"children"`, `"subAgents"`, `"refresh-token"` and accepts `"label"`, `"text"`, `"c"`.
  - A tree containing a forbidden key anywhere is dropped (use `{t:"Visual",k:"0",p:{path:{op:"lit",v:1}}}`).
  - `dataJson` over 64 KiB is dropped.
  - A serialized tree over 256 KiB is dropped.
- [ ] **Step 2: Run** `npx tsx --test renderer/shared/aiden-ui/visual.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.**
  - `types.ts` with the declarations above.
  - `visual.ts`: `parseChatUiVisualV1` validates version/kind, id (`/^[A-Za-z0-9._:-]{1,128}$/`), title (reuse `isHtmlArtifactTitle` from `../chat-artifacts`), `catalogVersion === 1`, tree shape (recursive check of `t` string, `k` string, `p` object of objects with `op` or `act`, `c` array, `s` string), depth ≤ 24, nodes ≤ 2000, all keys wire-safe, byte sizes, `fallbackText` ≤ 4000 chars, `state` serialized ≤ 4096 bytes, and `layout === "wide"` or absent.
  - `parseChatUiVisuals` caps at 60 entries and dedupes by id.
- [ ] **Step 4: Run.** Expected: PASS. Add the file to `test:generative-ui` in `package.json`; run `npm run test:ci-policy`.
- [ ] **Step 5: Commit** `feat(aiden-ui): visual contract types and lenient parser`.

### Task 2: Tolerant AUM parser

**Files:**
- Create: `renderer/shared/aiden-ui/parse.ts`, `renderer/shared/aiden-ui/expression.ts`
- Test: `renderer/shared/aiden-ui/parse.test.ts`

**Interfaces:**
- Produces:
```ts
export interface AumElement { kind: "element"; name: string; attrs: AumAttr[]; children: AumNode[]; closed: boolean }
export type AumNode = AumElement | { kind: "text"; text: string } | { kind: "expr"; source: string };
export interface AumAttr { name: string; value: { kind: "string"; text: string } | { kind: "expr"; source: string } | { kind: "bare" } }
export function parseAum(markup: string): { nodes: AumNode[]; diagnostics: AidenUiDiagnostic[] };
export function parseExpression(source: string): { expr?: AidenUiExprV1; action?: AidenUiActionV1; error?: string };
```
- Behavior:
  - Tags are `<Name …>`, `</Name>`, `<Name …/>`. Attribute values are `"…"`, `'…'`, or `{…}` with balanced braces, honoring strings inside braces.
  - `{expr}` is allowed as a child. HTML comments are skipped.
  - At EOF the parser auto-closes open elements (`recovered`), drops an unterminated attribute or expression, and keeps text.
  - A mismatched close tag closes up to the nearest matching open element. A close tag with no match is dropped with a diagnostic.
  - `<Data …>` bodies are raw text up to `</Data>`; braces inside are not expressions.
  - `parseExpression`:
    - Supports the full grammar in Global Constraints, plus JSON object and array literals (`op:"json"`) with unquoted keys allowed (`{value:"a",label:"A"}`).
    - Recognizes `sendPrompt(…)`, `setState("k", …)`, `openUrl(…)` and `copy(…)` as actions.
    - Numbers allow a leading `+`/`-`.
    - Unknown functions are errors.

- [ ] **Step 1: Write failing tests:**
  - The spec §5.1 example parses into one `Visual` element with expected children names.
  - Every prefix of that example (step 7 chars) parses without throwing, and each prefix's element names are a prefix-consistent subset.
  - A cut inside `value={$data.totals[` drops only that attribute.
  - `<Data name="d">{"a":{"b":1}}</Data>` keeps the body verbatim.
  - A stray `</Row>` produces a `recovered` diagnostic.
  - Expression vectors:
    - `$data.totals[$metric]` → `get(get(var data, lit totals), var metric)`
    - `"A" + $x`
    - `$m == "revenue" ? 1 : 2`
    - `fmt($v, "currency")`
    - `{value:"a",label:"A"}` → json
    - `sendPrompt("Break down " + $m)` → action send
    - `setState("tab", "b")` → action set
    - `eval(1)` → error
    - `$a.constructor` → `get`, parsed fine (the evaluator blocks it, Task 3)
- [ ] **Step 2: Run** `npx tsx --test renderer/shared/aiden-ui/parse.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** a hand-written scanner (no regex backtracking on the whole input, linear time) and a Pratt parser for expressions with precedence `|| < && < == != < < <= > >= < + < unary ! < postfix . []`.
- [ ] **Step 4: Run.** Expected: PASS. Register the test file.
- [ ] **Step 5: Commit** `feat(aiden-ui): tolerant markup and expression parser`.

### Task 3: Evaluator

**Files:**
- Create: `renderer/shared/aiden-ui/evaluate.ts`
- Test: `renderer/shared/aiden-ui/evaluate.test.ts`, `renderer/shared/aiden-ui/fixtures/expressions.json` (the cross-platform vector file Phase 4 ports will reuse)

**Interfaces:**
- Produces:
```ts
export interface AidenUiScope { vars: Readonly<Record<string, unknown>>; budget?: { steps: number } }
export function evaluate(expr: AidenUiExprV1, scope: AidenUiScope): unknown; // never throws; errors → undefined
export function formatValue(value: unknown, format: "currency" | "percent" | "number" | "date", locale?: string): string;
export function truthy(value: unknown): boolean;
```
- Rules:
  - `get` uses own properties only (`Object.hasOwn`) and blocks `__proto__`, `constructor` and `prototype`.
  - Array index requires an integer.
  - `+` adds numbers and otherwise concatenates the string forms.
  - Comparisons use strict equality for `==`/`!=` and numbers or strings for ordering.
  - `filter` and `sort` copy, cap at 10,000 input items, and never mutate.
  - `sum`, `max` and `min` accept a list of numbers, or a list plus a field name.
  - `round(x, digits?)`.
  - `fmt` uses `Intl.NumberFormat` (currency `USD` unless a 3rd arg is an ISO code) and `Intl.DateTimeFormat` for ISO date strings or epoch ms.
  - A step budget (default 20,000) returns `undefined` when exceeded.

- [ ] **Step 1: Write failing tests** driven by `fixtures/expressions.json`. Each case is `{name, expr, vars, expect}`, with ≥ 30 cases covering every op, every function, prototype keys, non-integer index, budget exhaustion, and `fmt` with currency/percent/number/date in the `en-US` locale.
- [ ] **Step 2: Run** `npx tsx --test renderer/shared/aiden-ui/evaluate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** a recursive `evaluate` with a shared budget counter and no `eval` or `Function`.
- [ ] **Step 4: Run.** Expected: PASS. Register.
- [ ] **Step 5: Commit** `feat(aiden-ui): pure expression evaluator with caps`.

### Task 4: Catalog and compiler

**Files:**
- Create: `renderer/shared/aiden-ui/catalog.ts`, `renderer/shared/aiden-ui/compile.ts`, `renderer/shared/aiden-ui/fallback-text.ts`, `renderer/shared/aiden-ui/fixtures/*.aum` (8 samples: dashboard, comparison table, steps/timeline, checklist, form-ish filter, chart+stats, explainer with math and code, and a broken-HTML-ish one)
- Test: `renderer/shared/aiden-ui/compile.test.ts`

**Interfaces:**
- Produces:
```ts
export type PropKind = "string" | "number" | "boolean" | "any" | "action" | { enum: readonly string[] } | "icon" | "stateKey";
export interface CatalogEntry { props: Readonly<Record<string, PropKind>>; children: "none" | "text" | "nodes"; required?: readonly string[] }
export const AIDEN_UI_CATALOG: Readonly<Record<string, CatalogEntry>>;
export const AIDEN_UI_ICONS: readonly string[]; // lucide allowlist, no Brain*
export function compileAum(markup: string, opts?: { draft?: boolean }): {
  tree?: AidenUiNodeV1; dataJson?: string; state?: Record<string, unknown>; title?: string;
  diagnostics: AidenUiDiagnostic[]; fallbackText: string;
};
export function fallbackTextFor(tree: AidenUiNodeV1, scope: AidenUiScope): string;
```
- The catalog (names are exactly these; every prop name passes `isWireSafeKey`):
  - Layout:
    - `Visual{title, state(any)}`
    - `Stack{gap:number, align:{enum start|center|end|stretch}}`
    - `Row{gap, align, wrap:boolean, justify:{enum start|center|end|between}}`
    - `Grid{columns:number, gap, minWidth:number}`
    - `Card{title, tone:{enum default|accent|green|red|warning}}`
    - `Section{title, description}`
    - `Separator{}`
    - `Spacer{size:number}`
  - Text:
    - `Text{tone:{enum primary|secondary|tertiary}, size:{enum small|regular|large}, weight:{enum regular|strong}}` (children: text)
    - `Heading{level:{enum 1|2|3}}`
    - `Markdown{}` (text)
    - `Code{lang}` (text)
    - `Math{display:boolean}` (text)
    - `Kbd{}` (text)
  - Data display:
    - `Stat{label, value(any), format:{enum number|currency|percent|date|text}, trend:number, caption}`
    - `Table{rows(any), columns(any), format(any)}`. `columns` items are `{key,label,format?}`. `key` is a data field name and is a JSON value, so it is not a wire key.
    - `KeyValue{items(any)}`
    - `List{}`
    - `ListRow{title, description, icon:"icon", meta, action:"action"}`
    - `Badge{color:{enum gray|green|red|blue|warning}, icon:"icon"}`
    - `Callout{color:{enum gray|green|red|blue|warning}, title}`
    - `Progress{value:number, max:number, label}`
    - `Meter{value, max, label, low, high}`
    - `Checklist{items(any)}`. Items are `{label, done}`.
    - `Timeline{items(any)}`. Items are `{title, time, description}`.
    - `Image{attachment, alt}`
    - `Icon{name:"icon", tone}`
    - `LinkCard{url, title, description}`
  - Charts:
    - `Chart{kind:{enum bar|line|area|pie|donut|scatter}, data(any), x, y(any), series(any), height:number, stacked:boolean, format}`
    - `BarList{items(any), label, value, format}`
    - `Heatmap{rows(any), x, y, value}`
    - `Sparkline{values(any), height}`
  - Input and state:
    - `Segmented{bind:"stateKey", options(any)}`
    - `Tabs{bind, options(any)}`. Tabs panels use `<If test={$tab == "a"}>`.
    - `Switch{bind, label}`
    - `Checkbox{bind, label}`
    - `RadioGroup{bind, options}`
    - `Select{bind, options, label}`
    - `Slider{bind, min, max, step, label, format}`
    - `TextInput{bind, label, placeholder}`
  - Actions:
    - `Button{variant:{enum accent|filled|muted|transparent}, action:"action", icon}` (text)
    - `ButtonGroup{}`
  - Disclosure:
    - `Disclosure{title, open:boolean}`
    - `Tooltip{content}`
  - Control flow: `Each{in(any), as}`, `If{test}`, `Data{name}`.
- Compile rules:
  - The root must be `Visual`. If it is missing, wrap the top-level nodes in `Visual` with a `recovered` diagnostic. With no nodes, there is no tree.
  - Unknown elements are dropped with `unknown_element`, but their text children are kept as `Text` so content survives (`<div>Hi</div>` → `Text "Hi"`).
  - Unknown props → `unknown_prop`.
  - `on*`, `className` and `style` props → `unknown_prop` with a hint ("use catalog props").
  - String-literal props for number, boolean or enum kinds are coerced or rejected (`invalid_literal`).
  - Action props must parse as actions.
  - `openUrl` must be an `https:` literal or an expression (it is re-checked at click).
  - `bind`'s value must be a declared state key.
  - `<Data>` JSON parse failure → `data_invalid`, and the binding becomes `null`.
  - Merged data is serialized ≤ 64 KiB, otherwise dropped with `limit`.
  - Node keys `k` are stable path indexes (`"0.2.1"`).
  - Enforce node, depth and tree caps by truncating with a `limit` diagnostic.
  - `title` comes from `<Visual title>` or the tool arg (Task 7).
  - `fallbackText` is computed with initial state, ≤ 4,000 chars:
    - Heading → `## text`
    - Stat → `Label: formatted value`
    - Table → a Markdown table (≤ 20 rows)
    - List, Checklist, Timeline → bullet lines
    - Callout → `> text`
    - Chart → `Chart (kind): n points`
    - Inputs are skipped.
    - Buttons → `[label]`.

- [ ] **Step 1: Write failing tests:**
  - Each fixture compiles with zero `unknown_element` diagnostics except the broken one, which reports `unknown_element` for `div` and `unknown_prop` for `onClick` while keeping its text.
  - Every compiled tree passes `parseChatUiVisualV1` (wire-safe, sizes).
  - A 2,500-node input truncates to ≤ 2,000 nodes with `limit`.
  - Depth 30 truncates.
  - `bind="undeclared"` → diagnostic.
  - The `fallbackText` of the dashboard fixture contains `Total: $6,930.00` and a Markdown table header.
  - Every `AIDEN_UI_CATALOG` prop name is wire-safe. This is a real invariant, because the projection key set is enforced elsewhere; iterate the catalog, call `isWireSafeKey` from `visual.ts`, and expect true.
  - `AIDEN_UI_ICONS` contains no name starting with `Brain`.
- [ ] **Step 2: Run** `npx tsx --test renderer/shared/aiden-ui/compile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `catalog.ts`, `compile.ts` (walk the AST, map attrs with `parseExpression`, extract `Data` and `state`) and `fallback-text.ts`.
- [ ] **Step 4: Run.** Expected: PASS. Register.
- [ ] **Step 5: Commit** `feat(aiden-ui): catalog, compiler, and fallback text`.

### Task 5: Shared primitives, adopted by existing call sites

**Files:**
- Create: `renderer/components/ui-primitives.tsx`, `renderer/components/ui-primitives.test.tsx`
- Modify:
  - `renderer/components/ui.tsx`: `Callout` gains `color: "gray"|"green"|"red"|"blue"|"warning"` with soft status fills; re-export the new primitives.
  - `renderer/main/scheduled-tasks-view.tsx:576-612`: All/Active/Paused → `Segmented`.
  - `renderer/components/chat-sidebar.tsx:648-661` and `renderer/components/settings/about-settings.tsx:236-250`: the hand-rolled bars → `Progress`.
  - `renderer/styles.css`: primitives styling using tokens only.
- Before styling, review `docs/chatgpt-desktop-ui-inspiration.md`, `docs/chatgpt-ui-element-specimen.html` and `docs/design-guide.md` (AGENTS.md).

**Interfaces:**
- Produces:
  - `Segmented<T extends string>({value, onValueChange, options: {value:T,label:ReactNode}[], "aria-label"})`, using Radix ToggleGroup single-select with `role="radiogroup"` semantics
  - `Tabs({value, onValueChange, items: {value,label}[], "aria-label"})`, using Radix Tabs list with roving focus
  - `Checkbox({checked, onCheckedChange, label})`
  - `Slider({value, min, max, step, onValueChange, label, valueLabel?})`
  - `Progress({value, max=100, label, indeterminate?})`
  - `Tooltip({content, children})`, using Radix Tooltip under the existing `TooltipProvider`
  - `Disclosure({title, defaultOpen, children})`, using Radix Collapsible with a squircle trigger `Button variant="transparent"`
  - `Kbd`
  - `Stat({label, value, caption?, trend?})`
  - `DataTable({columns:{key,label,align?}[], rows: Record<string,ReactNode>[], caption?})`, a semantic `<table>` with inset separators and no outer border

- [ ] **Step 1: Write failing tests** (happy-dom plus Testing Library, behavioral):
  - Segmented: arrow keys move the selection and call `onValueChange`, and the selected option is `aria-checked`.
  - Tabs: the active tab has `aria-selected`, and Home/End work.
  - Checkbox toggles via click and Space.
  - Slider's arrow key changes the value by `step`.
  - Progress exposes `role=progressbar` with `aria-valuenow` and an accessible name.
  - Disclosure toggles `aria-expanded` and content visibility.
  - DataTable renders `<th scope=col>` and row cells.
  - Callout `color="green"` renders `role` status semantics unchanged.
  - The scheduled-tasks view's filter is reachable by role `radiogroup` with name "Filter tasks"; extend the existing `scheduled-tasks-view` test if present.
- [ ] **Step 2: Run** `npx tsx --test renderer/components/ui-primitives.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement the primitives and adopt them at the three call sites.**
- [ ] **Step 4: Run** the new test plus the existing suites for the touched files:
  - `renderer/components/chat-sidebar*.test.tsx`
  - `renderer/components/settings/*about*.test.tsx`
  - `renderer/main/scheduled-tasks-view*.test.tsx`
  - `renderer/lib/button-appearance-contract.test.ts`
  - `renderer/components/interface-polish.test.tsx`

  Expected: PASS. Register the new test in `test:generative-ui`, or the renderer UI script the touched files already use, whichever owns `ui.tsx` tests.
- [ ] **Step 5: Commit** `feat(ui): shared tabs, segmented, checkbox, slider, progress, tooltip, disclosure, table and stat primitives`.

### Task 6: `AidenUiBlock` renderer and charts

**Files:**
- Create:
  - `renderer/components/aiden-ui/aiden-ui-block.tsx`
  - `renderer/components/aiden-ui/components.tsx`
  - `renderer/components/aiden-ui/chart.tsx`
  - `renderer/components/aiden-ui/aiden-ui-block.test.tsx`
- Modify: `renderer/styles.css`, adding `.aiden-ui-*` layout classes and reusing the `.aiden-inline-visual` caption and wide rules from Phase 1.

**Interfaces:**
- Consumes: `ChatUiVisualV1`, `evaluate`, `truthy`, `formatValue`, and the Task 5 primitives.
- Produces:
```tsx
export function AidenUiBlock(props: {
  visual: ChatUiVisualV1; draft?: boolean;
  onAction?: (action: { kind: "send"; text: string } | { kind: "copy"; text: string } | { kind: "open"; url: string }) => void;
  onStateChange?: (state: Record<string, unknown>) => void; // debounced by caller
}): React.ReactElement;
```
- Behavior:
  - Wrap in `<section role="figure" aria-label={title} data-aiden-ui={id} data-layout>` with the Phase 1 caption row: title plus **Copy as text**, which copies `fallbackText`. There is no Expand, because the block is native.
  - Keep local state in `useState`, initialized from `visual.state ?? tree.p.state`.
  - Scope `vars` = parsed `dataJson` entries + state keys + `Each` locals. State shadows data.
  - Bound inputs write state.
  - `setState` actions write state.
  - `send` actions call `onAction`.
  - `open` validates `https:` with `new URL`, then asks `window.confirm`-style through the app's `Dialog` ("Open link? <host>"), then calls `window.open(url, "_blank")`. The main window's open handler opens it externally.
  - `copy` uses `navigator.clipboard.writeText`.
  - `draft` disables all inputs and actions (`inert` on the content).
  - `Chart` lazy-imports `chart.js/auto` inside `useEffect`:
    - Read colors from computed `--chart-N`, `--text-secondary` and `--border-separator`.
    - Re-render on the appearance change event (`subscribeGenerativeUiTheme` from Phase 1).
    - Destroy on unmount.
    - Provide an accessible name and an sr-only data table fallback.
  - `BarList`, `Sparkline` (inline SVG) and `Heatmap` (CSS grid, ActivityHeatmap pattern) are native without Chart.js.
  - `Image` resolves an attachment id against the message's attachments, passed via context. If it is missing, render `alt` text.
  - Each node is rendered by a `components.tsx` map entry. Missing entries render nothing.
  - React keys are `node.k` plus the Each index.

- [ ] **Step 1: Write failing tests:**
  - Render the dashboard fixture (compiled via `compileAum`): the Stat shows "$6,930.00".
  - Clicking the "Margin" segmented option updates the Stat to the margin value and the chart's accessible description.
  - A Button with `sendPrompt` calls `onAction({kind:"send", text:"Break down EMEA margin by month"})`.
  - An `openUrl("http://x")` button does nothing (http rejected).
  - `draft` makes inputs disabled or inert.
  - `Each` over 3 items renders 3 rows.
  - Flipping `document.documentElement.classList` dark plus emitting the theme event keeps local state (the Segmented stays on "Margin").
  - "Copy as text" writes `fallbackText` (stub `navigator.clipboard`).
  - Mock `chart.js/auto` via a test seam (`setChartModuleLoader`) so tests don't load canvas.
- [ ] **Step 2: Run** `npx tsx --test renderer/components/aiden-ui/aiden-ui-block.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Run `npm run build` and `node scripts/check-renderer-bundle-budget.mjs` (or the npm script that wraps it). Expected: within budget, because the chart is a lazy chunk. Register the test.
- [ ] **Step 5: Commit** `feat(aiden-ui): native catalog renderer with local state, actions, and charts`.

### Task 7: `render_ui` tool, persistence, and live events (main)

**Files:**
- Create:
  - `main/services/aiden-ui-extension.ts`
  - `main/services/aiden-ui-extension.test.ts`
  - `main/services/aiden-ui-draft.ts`
  - `main/services/aiden-ui-draft.test.ts`
- Modify:
  - `renderer/shared/chat-artifacts.ts`: `ChatArtifactEventV1` gains `{operation:"ui", toolCallId?, visual: ChatUiVisualV1}` and `{operation:"ui_draft", toolCallId, visual: ChatUiVisualV1}`, with parse tests in `chat-artifacts.test.ts`.
  - `main/services/types.ts:324-328` and `renderer/lib/types.ts:624-626`: `uiVisuals?: ChatUiVisualV1[]`.
  - `main/services/chat-store-core.ts`: read mapping (~:842), `metaOf` (~:920), `copyVisibleHistory` (~:1391-1438, copied verbatim), `appendMessage` (~:1702).
  - `main/services/visible-chat-projection.ts:25-36,155-178`.
  - `main/services/memory-context.ts:86-95`: one metadata doc per ui visual with `title + fallbackText`.
  - `main/services/generation-timeline.ts:239`: `case "render_ui": return { label: "Render visual", detail: safeDetail(values.title) }`.
  - `main/services/generation-profile.ts:49` and `renderer/lib/agent-activity.ts:88`: add `render_ui` where `render_artifact` is allowed.
  - `main/services/generative-ui-extension.ts`: the guide gains a `catalog` module, and the system prompt says to prefer `render_ui`.
  - `main/services/generative-ui-guide.ts`: add a `catalog` module listing the components, the expression and action syntax, and an example.
  - `main/services/llm-client.ts`:
    - Register the ui extension with the same gate as the HTML extension (`shouldEnableGenerativeUiExtension`).
    - Collect `displayedUiVisuals`.
    - Send `ui` and `ui_draft` events.
    - Persist `uiVisuals` in `persistAssistant` (~:2364).
    - Feed `toolcall_delta`/`toolcall_end` to the ui draft session.
    - Cancel it on `tool_execution_end`.

**Interfaces:**
- Consumes: `compileAum`, `parseChatUiVisualV1`, the placement ledger pattern (`createArtifactPlacementLedger` resolver for public `call-N` ids).
- Produces:
  - `createAidenUiExtensionRuntime({ existingChatUiCount, preferThisTurn, onVisual(visual, {toolCallId}) })`
  - Tool `render_ui({title, layout?: "column"|"wide", markup})`. The schema orders `title`, then `layout`, then `markup`.
  - The tool result text is `Rendered visual "<title>" (n nodes).`, followed by up to 12 diagnostics, one per line (`- unknown_element: div (dropped)`), so the model can fix them next call.
  - A fatal compile (no tree) throws `Error("render_ui produced no visual: …diagnostics")`.
  - Same-title replace within a generation keeps the first call's id and position (mirror Phase 1).
  - Caps: 8 per response, 60 per chat.

- [ ] **Step 1: Write failing tests:**
  - Executing the tool with the dashboard markup calls `onVisual` with a visual that passes `parseChatUiVisualV1`, and the result text contains no markup.
  - Broken markup returns diagnostics in the result text.
  - Empty markup throws.
  - A ninth visual in one generation throws.
  - Same-title replace keeps the id.
  - Draft session: deltas with partial `markup` emit throttled `ui_draft` events whose visuals parse. `cancel` emits nothing further. Other tool names are ignored.
  - Event parser tests for `ui`/`ui_draft` (valid, and an invalid visual rejected).
  - chat-store round trip: an appended assistant message with `uiVisuals` reads back. One invalid entry is dropped and the valid one survives. Extend `main/services/chat-store-core.test.ts` and `chat-session-copy.test.ts` (copy keeps `uiVisuals`).
  - Memory metadata includes the fallback text. Extend that service's existing test if there is one; otherwise the test lives in `aiden-ui-extension.test.ts` via `memoryMetadataForChat`.
- [ ] **Step 2: Run** the new and extended tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:generative-ui`, `npx tsx --test main/services/chat-store-core.test.ts main/services/chat-session-copy.test.ts`, and `npx tsc --noEmit`. Expected: PASS. Register the new tests.
- [ ] **Step 5: Commit** `feat(aiden-ui): render_ui tool, streaming drafts, and message persistence`.

### Task 8: Local state write-back

**Files:**
- Modify:
  - `main/handlers/chats.ts`: new IPC `chats:updateUiVisualState(chatId, messageId, visualId, state)`, validated, capped at 4 KiB, assistant messages only.
  - `main/services/chat-store-core.ts`: new method `updateUiVisualState` (shared lock, `readChat` owner, mutate, `writeChatAndMeta`).
  - `renderer/lib/ipc` client wrapper.
- Test: extend `main/services/chat-store-core.test.ts`, and the handler parse test next to existing chat handler tests (call the parser).

- [ ] **Step 1: Write failing tests:**
  - The state persists and reads back.
  - Oversized state is rejected.
  - An unknown visual id or user message → `false`.
  - Keys failing `isWireSafeKey` are rejected.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The renderer debounces 800 ms in `AidenUiBlock`'s caller (Task 9).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(aiden-ui): persist a visual's local state`.

### Task 9: Transcript placement, chat pane wiring, and follow-ups

**Files:**
- Modify:
  - `renderer/lib/html-artifact-transcript.ts`: generalize slots to also place `ChatUiVisualV1` by `toolCallId` (`uiByRowKey`, `uiTrailing`, `uiDraftsByRowKey`).
  - `renderer/components/message-list.tsx`: render `AidenUiBlock` in the slots for settled (`message.uiVisuals`) and streaming visuals.
  - `renderer/main/chat-pane.tsx`: `streamingUiVisuals` and `uiDrafts` state from `ui`/`ui_draft` events. A `send` action goes through the existing `handleVisualPrompt` (busy → `stageComposerText`). State changes are debounced to IPC.
  - `renderer/lib/chat-terminal-sync.ts`: the detached projection keeps ui visuals.
- Test:
  - Extend `renderer/components/message-list-visuals.test.tsx`: a settled ui visual renders after its tool row; a streaming ui draft renders inert in its row and yields to the presented visual.
  - Extend `renderer/lib/html-artifact-transcript.test.ts`.

- [ ] **Step 1: Write failing tests:**
  - The settled placement order is activity row → ui block → later text.
  - The draft is inert, and the presented visual replaces it with the same node.
  - A `send` action while `visualFollowUpBusy` stages composer text (assert via `subscribeStagedComposerText`) and does not call the send handler.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run test:generative-ui` and the message-bubble/composer neighbors. Expected: PASS.
- [ ] **Step 5: Commit** `feat(aiden-ui): place native visuals in the transcript and wire actions`.

### Task 10: CLI fallback

**Files:**
- Modify:
  - `packages/cli/src/extensions/artifacts.ts`: a second tool `render_ui` that compiles with the shared compiler and returns `fallbackText` plus diagnostics as text (no export in this phase).
  - `packages/cli/src/selfcheck.ts:30`
  - `packages/cli/tests/extensions.test.mjs:55-66`
  - `packages/cli/README.md:39`
- Test: `packages/cli/tests/extensions.test.mjs` asserts that the tool list includes `render_ui` and that executing it returns the fallback text.

- [ ] **Step 1: Write the failing test.** **Step 2: Run** `cd packages/cli && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** The CLI bundles `renderer/shared` via `aidenRelativeTsRewritePlugin`, so import from `../../../../renderer/shared/aiden-ui/compile.js`.
- [ ] **Step 4: Run** `cd packages/cli && npm run build && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): render_ui text fallback`.

### Task 11: Onboarding tile and docs

**Files:**
- Modify:
  - `renderer/components/onboarding-flow.tsx`: a `visuals` entry in `FEATURE_ILLUSTRATIONS` and `featureBentos` ("Inline visuals": "Ask for a chart, dashboard or checklist and Aiden draws it right in the reply with the app's own components.").
  - `renderer/components/onboarding-flow.test.tsx`: the asset list and count go from 27 to 28.
  - `docs/pi-gui-artifacts.md`: a Tier A section.
  - `.memory/inline-generative-ui.md`
  - `docs/plans/README.md`: Phase 2 status.
- Create: `renderer/assets/onboarding/features/aiden-visuals.png`, 1024×1024 RGBA. Author it as SVG in Aiden's illustration style (soft surfaces, chart-token hues, no borders). Rasterize with Playwright `omitBackground: true`, then run `npm run assets:onboarding`.

- [ ] **Step 1: Update the test list and count first.** Run `npm run test:onboarding`. Expected: FAIL (missing asset).
- [ ] **Step 2: Create the PNG and the tile.**
- [ ] **Step 3: Run** `npm run test:onboarding`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(onboarding): inline visuals feature tile`.

### Task 12: Model eval script and final verification

**Files:**
- Create:
  - `scripts/eval-aiden-ui.mjs`: 40 prompts. For each configured provider it asks for a visual through the real `render_ui` tool schema and records parse success after repair, diagnostics per visual, markup tokens, and whether a plain-Q&A prompt avoided a visual. Uses the user's configured provider keys; never runs in CI.
  - `docs/superpowers/plans/aiden-ui-eval.md`: how to run it and the results table.

- [ ] **Step 1: Write the script** with a `--dry-run` mode that compiles the fixture corpus instead of calling models. Run it with `node scripts/eval-aiden-ui.mjs --dry-run`. Expected: prints a 100% parse table for the fixtures.
- [ ] **Step 2: Full verification:**
  - `npm run test:generative-ui`
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npm run test:ci-policy`
  - `npm test`
  - The settings e2e spec

  Expected: all green.
- [ ] **Step 3: Commit** `chore(aiden-ui): eval harness and phase 2 docs`.
