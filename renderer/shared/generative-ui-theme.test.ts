import assert from "node:assert/strict";
import test from "node:test";
import { GENERATIVE_UI_THEME_VARIABLES, sanitizeGenerativeUiThemeVars } from "./generative-ui-theme.js";

test("theme vars keep allowlisted names with safe values only", () => {
  const out = sanitizeGenerativeUiThemeVars({
    "--accent": "#0B7DE5",
    "--status-green-surface": "rgba(30, 160, 90, 0.16)",
    "--status-warning-surface": "rgb(255 176 32 / 0.080)",
    "--radius-card": "12px",
    "--ui-font-size": "14px",
    "--font-ui-family": '\n    -apple-system, BlinkMacSystemFont, "SF Pro Text",\n    system-ui, sans-serif',
    "--motion-easing": "cubic-bezier(0.16, 1, 0.3, 1)",
    "--text-primary": "red; background: url(https://evil)",
    "--font-code-family": "x}body{display:none",
    "--surface-well": "url(data:x)",
    "--not-allowed": "#000000",
    "--chart-1": "oklch(0.7 0.1 250)",
    "--chart-2": "",
  });
  assert.deepEqual(out, {
    "--accent": "#0b7de5",
    "--status-green-surface": "rgba(30, 160, 90, 0.16)",
    "--status-warning-surface": "rgb(255 176 32 / 0.080)",
    "--radius-card": "12px",
    "--ui-font-size": "14px",
    "--font-ui-family": '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    "--motion-easing": "cubic-bezier(0.16, 1, 0.3, 1)",
    "--chart-1": "oklch(0.7 0.1 250)",
  });
});

test("non-object input yields no vars", () => {
  assert.deepEqual(sanitizeGenerativeUiThemeVars(null), {});
  assert.deepEqual(sanitizeGenerativeUiThemeVars(["--accent", "#fff"]), {});
  assert.deepEqual(sanitizeGenerativeUiThemeVars({ "--accent": 5 }), {});
});

test("the allowlist includes the categorical chart series", () => {
  for (let i = 1; i <= 8; i += 1) assert.ok(GENERATIVE_UI_THEME_VARIABLES.includes(`--chart-${i}` as never));
});
