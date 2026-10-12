import { AIDEN_UI_CATALOG, AIDEN_UI_ICONS, type PropKind } from "../../renderer/shared/aiden-ui/catalog.js";

/**
 * On-demand design guidance for inline visuals, returned by the
 * `visualize_guide` tool so the system prompt stays short.
 */
export const GENERATIVE_UI_GUIDE_MODULES = ["catalog", "design", "html", "charts", "interactive"] as const;
export type GenerativeUiGuideModule = (typeof GENERATIVE_UI_GUIDE_MODULES)[number];

/** The catalog guide's worked example; a test keeps it compiling cleanly. */
export const AIDEN_UI_GUIDE_EXAMPLE = `<Visual title="Q3 revenue" state={{metric: "revenue"}}>
  <Row>
    <Stat label="Total" value={$data.totals[$metric]} format={$metric == "revenue" ? "currency" : "percent"} />
    <Stat label="Regions" value={len($data.rows)} />
  </Row>
  <Segmented bind="metric" label="Metric" options={[{value:"revenue",label:"Revenue"},{value:"margin",label:"Margin"}]} />
  <Chart kind="bar" data={$data.rows} x="region" y={$metric} label="By region" />
  <List>
    <Each in={sort($data.rows, "revenue", "desc")} as="row">
      <ListRow title={$row.region} meta={fmt($row.revenue, "currency")} action={sendPrompt("Break down " + $row.region + " by month")} />
    </Each>
  </List>
  <Data name="data">{"totals": {"revenue": 6930, "margin": 0.31}, "rows": [{"region": "EMEA", "revenue": 2400, "margin": 0.28}, {"region": "AMER", "revenue": 3100, "margin": 0.35}]}</Data>
</Visual>`;

function describeKind(kind: PropKind): string {
  if (typeof kind === "object") return kind.enum.join("|");
  if (kind === "stateKey") return "state key";
  return kind;
}

function catalogReference(): string {
  return Object.entries(AIDEN_UI_CATALOG)
    .map(([name, entry]) => {
      const props = Object.entries(entry.props).map(([prop, kind]) => `${prop}: ${describeKind(kind)}`);
      const children = entry.children === "nodes" ? "components" : entry.children === "text" ? "text" : "no children";
      return `- \`${name}\` — ${props.length ? props.join(", ") : "no props"}; ${children}`;
    })
    .join("\n");
}

const CATALOG = `## Aiden UI catalog (render_ui)
- Prefer \`render_ui\`: it draws with Aiden's own components, looks native, follows the theme, and works without scripts. Use \`render_artifact\` only for custom drawing or scripting (canvas, simulations, 3D, Plotly).
- Start with \`<Visual title="…">\`. Elements are JSX-like and must come from the catalog below. HTML elements, \`className\`, \`style\`, and \`on…\` handlers are dropped and reported back to you.
- Prop values: \`"text"\`, \`{3}\`, \`{true}\`, a bare flag (\`stacked\`), \`{expression}\`, or a constant literal like \`{[{value:"a",label:"A"}]}\`.
- Data: put JSON in \`<Data name="data">{…}</Data>\` and read it as \`$data\`. Keep numbers in data and let the components format them.
- Expressions: \`$name\`, \`$a.b\`, \`$a[$key]\`, literals, \`+\` (adds numbers, joins text), \`== != < <= > >=\`, \`&& || !\`, \`test ? a : b\`, and \`fmt(value, "currency"|"percent"|"number"|"date")\`, \`len(x)\`, \`sum(list, "field")\`, \`max(list, "field")\`, \`min(…)\`, \`round(x, digits)\`, \`filter(list, "field", value)\`, \`sort(list, "field", "asc"|"desc")\`. There is no \`-\`, \`*\`, \`/\`, method call, or arrow function: precompute values into data.
- Local state: declare keys in \`<Visual state={{tab: "a"}}>\`, bind inputs with \`bind="tab"\`, and change state with \`action={setState("tab", "b")}\`. Show parts conditionally with \`<If test={$tab == "a"}>\` and repeat with \`<Each in={$data.rows} as="row">…{$row.name}…</Each>\`.
- Actions: \`sendPrompt("…")\` sends a visible follow-up message as the user (phrase it as their message), \`setState\`, \`openUrl("https://…")\` (Aiden asks before opening), \`copy("…")\`.
- Width: \`layout\` defaults to the reading column (about 690px); pass \`layout: "wide"\` (before \`markup\`) to span the chat pane for dashboards and wide tables. Everything reflows with the window.
- Keep it compact, sentence case, and keep the takeaway in your prose too. Repairs Aiden made come back in the tool result: fix them on your next call.

Components:
${catalogReference()}

Icons (\`icon="…"\` / \`<Icon name="…">\`): ${AIDEN_UI_ICONS.join(", ")}.

Example:
\`\`\`
${AIDEN_UI_GUIDE_EXAMPLE}
\`\`\``;

const MODULES: Record<GenerativeUiGuideModule, string> = {
  catalog: CATALOG,
  design: `## Design
- Visuals render inside your reply in the Aiden desktop chat, on a transparent background, and their height follows their content (up to 1600px). Do not add an outer border, shadow, page background, or a heading that repeats the title (the title is shown under the visual).
- Width: by default a visual fills the reading column (about 690px, narrower in small windows). Pass \`layout: "wide"\` (before \`html\`, so the draft streams at the right width) to span the chat pane instead (up to about 1280px) for dashboards, UI mockups, multi-panel layouts, and wide tables. Width follows the window in both, so lay out with flex/grid and percentages, never a fixed page width, and cap text line lengths yourself in wide visuals.
- Use Aiden's kit classes so the visual matches the app: \`.aiden-card\` (borderless surface), \`.aiden-stack\` / \`.aiden-row\` / \`.aiden-grid\` (layout), \`.aiden-stat\` with \`.aiden-stat-label\` and \`.aiden-stat-value\`, \`.aiden-table\`, \`.aiden-badge\` (neutral) or \`.aiden-badge[data-color=green|red|blue|warning]\`, \`.aiden-callout[data-color=…]\`, \`.aiden-btn\` (neutral) or \`.aiden-btn[data-variant=accent|muted|transparent|destructive]\`, \`.aiden-tabs\` with \`[role=tab][aria-selected]\`, \`.aiden-input\`, \`.aiden-muted\`.
- Use theme tokens instead of hard-coded colors: \`var(--text-primary)\`, \`var(--text-secondary)\`, \`var(--surface-well)\`, \`var(--accent)\`, \`var(--status-green)\` and their \`-surface\` fills, \`var(--chart-1)\` … \`var(--chart-8)\` for series. They follow light and dark mode live.
- Keep it compact (usually under ~600px tall), use sentence case, and never put essential information only in color.`,
  html: `## HTML structure
- Send an HTML fragment, not a full page: one root element, then an inline \`<style>\`, the markup, and an inline \`<script>\` last.
- No network: no CDN scripts, fonts, images, or fetch calls. Chart.js (\`Chart\`), Plotly (\`Plotly\`), and KaTeX (\`katex\`) are already loaded.
- Aiden provides \`window.aiden\`. Do not declare \`aiden\` yourself (no \`const aiden\` / \`let aiden\`); call \`window.aiden.sendPrompt(text)\`, \`window.aiden.theme()\`, or \`window.aiden.series()\` directly.
- Redraw custom canvases on \`window.addEventListener("aiden:themechange", …)\`.`,
  charts: `## Charts
- Chart.js is preconfigured with Aiden's text, grid, and font colors. Color datasets from \`aiden.series()\` (eight categorical colors) — never from status colors.
- Colors taken directly from \`aiden.series()\` are recolored automatically when the theme changes. Colors derived from them (for example with added transparency) or drawn on custom canvases must be recomputed in a \`window.addEventListener("aiden:themechange", …)\` handler, then \`chart.update()\`.
- Put the canvas in a container with an explicit height and use \`responsive: true, maintainAspectRatio: false\`.
- Prefer bar/line/area/doughnut in Chart.js; use Plotly for 3D, statistical, or scientific plots; KaTeX for math.
- Label axes and units, and keep the key number visible as text (for example a \`.aiden-stat\`) beside the chart.`,
  interactive: `## Interactivity
- Keep local state in plain JavaScript variables; tabs, toggles, sliders, and filters should update the visual without asking the model.
- When a control should ask a follow-up question, call \`window.aiden.sendPrompt("…")\` from a click handler. Aiden shows the text under the visual for the user to confirm before it is sent, so phrase it as the message the user would send. Never call it on load or from a timer.
- Every control needs a visible label and keyboard support; buttons must be \`<button>\` elements.`,
};

export function isGenerativeUiGuideModule(value: unknown): value is GenerativeUiGuideModule {
  return typeof value === "string" && (GENERATIVE_UI_GUIDE_MODULES as readonly string[]).includes(value);
}

export function generativeUiGuide(modules: readonly GenerativeUiGuideModule[]): string {
  const unique = GENERATIVE_UI_GUIDE_MODULES.filter((module) => modules.includes(module));
  return unique.map((module) => MODULES[module]).join("\n\n");
}
