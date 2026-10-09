/**
 * On-demand design guidance for inline visuals, returned by the
 * `visualize_guide` tool so the system prompt stays short.
 */
export const GENERATIVE_UI_GUIDE_MODULES = ["design", "html", "charts", "interactive"] as const;
export type GenerativeUiGuideModule = (typeof GENERATIVE_UI_GUIDE_MODULES)[number];

const MODULES: Record<GenerativeUiGuideModule, string> = {
  design: `## Design
- Visuals render inline in the chat on a transparent background and size to their content. Do not add an outer border, shadow, page background, or a heading that repeats the title (the title is shown under the visual).
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
- Put the canvas in a container with an explicit height and use \`responsive: true, maintainAspectRatio: false\`.
- Prefer bar/line/area/doughnut in Chart.js; use Plotly for 3D, statistical, or scientific plots; KaTeX for math.
- Label axes and units, and keep the key number visible as text (for example a \`.aiden-stat\`) beside the chart.`,
  interactive: `## Interactivity
- Keep local state in plain JavaScript variables; tabs, toggles, sliders, and filters should update the visual without asking the model.
- When a control should ask a follow-up question, call \`window.aiden.sendPrompt("…")\` from a click handler. It sends a normal, visible message. Never call it on load or from a timer.
- Every control needs a visible label and keyboard support; buttons must be \`<button>\` elements.`,
};

export function isGenerativeUiGuideModule(value: unknown): value is GenerativeUiGuideModule {
  return typeof value === "string" && (GENERATIVE_UI_GUIDE_MODULES as readonly string[]).includes(value);
}

export function generativeUiGuide(modules: readonly GenerativeUiGuideModule[]): string {
  const unique = GENERATIVE_UI_GUIDE_MODULES.filter((module) => modules.includes(module));
  return unique.map((module) => MODULES[module]).join("\n\n");
}
