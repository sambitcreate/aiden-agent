/**
 * `aiden-ui.css`: a guest-side mirror of Aiden's shared components so model
 * HTML can look native. It reads only the allowlisted theme variables
 * (renderer/shared/generative-ui-theme.ts), each with a constant fallback, and
 * follows docs/design-guide.md: squircle buttons, borderless cards, status as
 * soft fills, neutral focus rings, and no focus ring on text entry.
 */
const KIT_CSS = `
:root {
  --aiden-gap: 12px;
  --aiden-text: var(--text-primary, var(--artifact-text, #3d3f41));
  --aiden-muted: var(--text-secondary, var(--artifact-secondary, #6b6b68));
  --aiden-accent: var(--accent, var(--artifact-accent, #006ad6));
}
.aiden-muted { color: var(--aiden-muted); }
.aiden-stack { display: flex; flex-direction: column; gap: var(--aiden-gap); }
.aiden-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--aiden-gap); }
.aiden-grid { display: grid; gap: var(--aiden-gap); grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
.aiden-card {
  background: var(--surface-well, rgb(0 0 0 / 0.04));
  border: 0;
  border-radius: var(--radius-card, 12px);
  padding: 16px;
  min-width: 0;
}
.aiden-btn {
  appearance: none;
  border: 0;
  border-radius: var(--radius-button, 16px);
  corner-shape: squircle;
  padding: 6px 14px;
  min-height: 32px;
  font: inherit;
  font-weight: 500;
  color: var(--aiden-text);
  background: var(--surface-control, rgb(0 0 0 / 0.06));
  cursor: pointer;
  transition: background-color var(--motion-duration, 200ms) var(--motion-easing, ease), transform var(--motion-duration, 200ms) var(--motion-easing, ease);
}
.aiden-btn:hover { background: var(--surface-control-hover, rgb(0 0 0 / 0.09)); }
.aiden-btn:active { transform: translateY(1px); }
.aiden-btn:focus-visible { outline: 2px solid var(--focus-ring, #8a8a8a); outline-offset: 2px; }
.aiden-btn:disabled { opacity: 0.5; cursor: default; }
.aiden-btn[data-variant="accent"] { background: var(--aiden-accent); color: var(--accent-foreground, #ffffff); }
.aiden-btn[data-variant="accent"]:hover { background: var(--accent-hover, var(--aiden-accent)); }
.aiden-btn[data-variant="muted"] { background: var(--surface-well, rgb(0 0 0 / 0.04)); }
.aiden-btn[data-variant="transparent"] { background: transparent; }
.aiden-btn[data-variant="transparent"]:hover { background: var(--surface-list-hover, rgb(0 0 0 / 0.05)); }
.aiden-btn[data-variant="destructive"] { background: var(--status-red-surface, rgb(220 50 50 / 0.1)); color: var(--status-red, #c62828); }
.aiden-badge {
  display: inline-flex; align-items: center; gap: 4px;
  border: 0; border-radius: var(--radius-pill, 9999px);
  padding: 2px 8px; font-size: 0.85em; font-weight: 500;
  background: var(--surface-well, rgb(0 0 0 / 0.05)); color: var(--aiden-muted);
}
.aiden-badge[data-color="green"] { background: var(--status-green-surface); color: var(--status-green); }
.aiden-badge[data-color="red"] { background: var(--status-red-surface); color: var(--status-red); }
.aiden-badge[data-color="warning"] { background: var(--status-warning-surface); color: var(--status-warning); }
.aiden-badge[data-color="blue"] { background: var(--status-accent-surface); color: var(--status-accent); }
.aiden-callout { border: 0; border-radius: var(--radius-card, 12px); padding: 12px 14px; background: var(--surface-well, rgb(0 0 0 / 0.04)); }
.aiden-callout[data-color="green"] { background: var(--status-green-surface); }
.aiden-callout[data-color="red"] { background: var(--status-red-surface); }
.aiden-callout[data-color="warning"] { background: var(--status-warning-surface); }
.aiden-callout[data-color="blue"] { background: var(--status-accent-surface); }
.aiden-stat { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.aiden-stat-label { color: var(--aiden-muted); font-size: 0.85em; }
.aiden-stat-value { font-size: 1.6em; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; }
.aiden-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.aiden-table th { text-align: left; font-weight: 500; color: var(--aiden-muted); }
.aiden-table th, .aiden-table td { padding: 8px 10px; border-bottom: 1px solid var(--border-separator, rgb(0 0 0 / 0.08)); }
.aiden-table tr:last-child td { border-bottom: 0; }
.aiden-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--radius-control, 12px); background: var(--surface-well, rgb(0 0 0 / 0.04)); }
.aiden-tabs [role="tab"] {
  appearance: none; border: 0; font: inherit; color: var(--aiden-muted); cursor: pointer;
  padding: 4px 12px; border-radius: calc(var(--radius-control, 12px) - 2px); background: transparent;
}
.aiden-tabs [role="tab"][aria-selected="true"] { background: var(--surface-list-selection, rgb(0 0 0 / 0.08)); color: var(--aiden-text); }
.aiden-tabs [role="tab"]:focus-visible { outline: 2px solid var(--focus-ring, #8a8a8a); outline-offset: 1px; }
.aiden-input {
  font: inherit; color: var(--aiden-text);
  border: 1px solid var(--border-field, rgb(0 0 0 / 0.12));
  border-radius: var(--radius-control, 12px);
  padding: 6px 10px; background: var(--surface-input, transparent);
  outline: none;
}
.aiden-input:focus { outline: none; background: var(--surface-control, rgb(0 0 0 / 0.06)); }
`;

export function generativeUiKitCss(): string {
  return KIT_CSS;
}
