import {
  getPresetVariant,
  resolveThemeTokens,
  type ThemePresetId,
} from "../../../renderer/shared/appearance";
import type { DialConfig } from "dialkit";

export interface Look {
  appearance: { palette: string; mode: string; contrast: number };
  typography: { font: string; size: number; lineHeight: number };
  layout: {
    arrangement: string;
    padding: number;
    gap: number;
    chrome: boolean;
  };
  details: {
    activity: string;
    timestamps: boolean;
    context: boolean;
    usage: boolean;
    diff: string;
    prompt: string;
  };
  motion: { animation: string; speed: number; reduced: boolean };
}
export interface Direction {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  changes: string[];
  look: Look;
}
const base: Look = {
  appearance: { palette: "slate", mode: "dark", contrast: 65 },
  typography: { font: "plex", size: 13, lineHeight: 1.8 },
  layout: { arrangement: "stream", padding: 28, gap: 20, chrome: true },
  details: {
    activity: "compact",
    timestamps: false,
    context: true,
    usage: true,
    diff: "unified",
    prompt: "›",
  },
  motion: { animation: "fade", speed: 1, reduced: false },
};
function look(overrides: { [K in keyof Look]?: Partial<Look[K]> }): Look {
  return {
    appearance: { ...base.appearance, ...overrides.appearance },
    typography: { ...base.typography, ...overrides.typography },
    layout: { ...base.layout, ...overrides.layout },
    details: { ...base.details, ...overrides.details },
    motion: { ...base.motion, ...overrides.motion },
  };
}
export const DIRECTIONS: Direction[] = [
  {
    id: "quiet",
    name: "Quiet",
    tagline: "Room to think.",
    category: "Balanced",
    description:
      "A spacious conversation with compact tool summaries. Familiar Aiden, with a little more breathing room.",
    changes: [
      "A quiet, single-column conversation",
      "Grouped activity instead of a running log",
      "A compact context line beneath the prompt",
    ],
    look: look({}),
  },
  {
    id: "blueprint",
    name: "Blueprint",
    tagline: "Everything in its place.",
    category: "Structured",
    description:
      "A persistent project rail keeps files and context visible while the conversation stays in focus.",
    changes: [
      "A narrow project and file rail",
      "Visible timestamps on every step",
      "Tighter spacing for longer sessions",
    ],
    look: look({
      appearance: { palette: "aiden" },
      layout: { arrangement: "rail", padding: 20, gap: 14 },
      details: { timestamps: true, activity: "detailed" },
      typography: { size: 12, lineHeight: 1.7 },
    }),
  },
  {
    id: "field-notes",
    name: "Field Notes",
    tagline: "A working notebook.",
    category: "Editorial",
    description:
      "A light, moss-toned journal. Numbered entries give a long investigation an easy rhythm to follow.",
    changes: [
      "Numbered journal entries",
      "A soft daytime palette",
      "Open spacing and a simple dollar prompt",
    ],
    look: look({
      appearance: { palette: "moss", mode: "light" },
      layout: { arrangement: "journal", padding: 32, gap: 26 },
      details: { prompt: "$", usage: false },
      motion: { animation: "none" },
    }),
  },
  {
    id: "midnight",
    name: "Midnight",
    tagline: "Stay in the flow.",
    category: "Split view",
    description:
      "Berry after dark. Put the conversation beside the changes, with a distinct reading area for each.",
    changes: [
      "Conversation and changes side by side",
      "A restrained berry accent",
      "A gently pulsing prompt indicator",
    ],
    look: look({
      appearance: { palette: "berry", contrast: 75 },
      layout: { arrangement: "split", padding: 22 },
      details: { diff: "split", prompt: "▸" },
      motion: { animation: "pulse" },
    }),
  },
  {
    id: "focus",
    name: "Focus",
    tagline: "Just you and the task.",
    category: "Minimal",
    description:
      "The smallest possible interface. Hide the chrome and metadata, and keep the answer in a narrow reading column.",
    changes: [
      "No window chrome or persistent metadata",
      "A centered reading column",
      "Tool details stay collapsed",
    ],
    look: look({
      layout: { arrangement: "focus", padding: 38, gap: 28, chrome: false },
      details: { activity: "hidden", context: false, usage: false },
      typography: { size: 14, lineHeight: 1.9 },
      motion: { animation: "none" },
    }),
  },
  {
    id: "workshop",
    name: "Workshop",
    tagline: "Built around the diff.",
    category: "Review first",
    description:
      "A practical daytime workbench. Put edited files first and make additions and removals easy to scan.",
    changes: [
      "Changes lead the session",
      "A compact file change summary",
      "A readable, unified patch preview",
    ],
    look: look({
      appearance: { palette: "aiden", mode: "light" },
      layout: { arrangement: "review", padding: 22, gap: 16 },
      details: { activity: "detailed", timestamps: true, prompt: "❯" },
      typography: { lineHeight: 1.65 },
    }),
  },
  {
    id: "expedition",
    name: "Expedition",
    tagline: "See the team at work.",
    category: "Agent oriented",
    description:
      "A moss-toned command center for delegated work. Show the scout, planner, and reviewer beside the main task.",
    changes: [
      "A small, persistent subagent roster",
      "Progress reported per investigation",
      "Clear separation between task and child results",
    ],
    look: look({
      appearance: { palette: "moss" },
      layout: { arrangement: "agents", padding: 24 },
      details: { activity: "detailed", prompt: "λ" },
      motion: { animation: "pulse", speed: 0.8 },
    }),
  },
  {
    id: "signal",
    name: "Signal",
    tagline: "High information. Low noise.",
    category: "Compact",
    description:
      "A dense event stream for experienced terminal users. More activity, fewer empty rows, and a terse prompt.",
    changes: [
      "An aligned event log",
      "Compact rows with timestamps",
      "Minimal labels and a short prompt",
    ],
    look: look({
      appearance: { palette: "berry" },
      layout: { arrangement: "log", padding: 18, gap: 10 },
      typography: { size: 12, lineHeight: 1.5 },
      details: { activity: "detailed", timestamps: true, prompt: ">" },
      motion: { animation: "none", speed: 1.4 },
    }),
  },
  {
    id: "paper",
    name: "Paper",
    tagline: "A clean sheet.",
    category: "Daylight",
    description:
      "Almost a plain-text document. Bright slate, generous line spacing, and no window decoration.",
    changes: [
      "An unframed light terminal",
      "Text-first tool and diff summaries",
      "Long-form reading without visual decoration",
    ],
    look: look({
      appearance: { palette: "slate", mode: "light", contrast: 80 },
      layout: { arrangement: "journal", padding: 36, gap: 24, chrome: false },
      typography: { font: "courier", size: 14, lineHeight: 1.85 },
      details: { diff: "summary", usage: false },
      motion: { animation: "none" },
    }),
  },
  {
    id: "observatory",
    name: "Observatory",
    tagline: "The whole session, at a glance.",
    category: "Instrumented",
    description:
      "Keep model, context, and usage in a dedicated header. A measured view for longer coding sessions.",
    changes: [
      "An always-visible session meter",
      "Task progress and usage at the top",
      "Conversation beneath a stable status strip",
    ],
    look: look({
      appearance: { palette: "aiden", contrast: 70 },
      layout: { arrangement: "dashboard", padding: 22, gap: 16 },
      details: { activity: "compact", timestamps: true, prompt: "❯" },
      motion: { animation: "fade", speed: 0.7 },
    }),
  },
];
export const DIALS = {
  appearance: {
    palette: {
      type: "select",
      options: ["slate", "aiden", "moss", "berry"],
      default: "slate",
    },
    mode: { type: "select", options: ["dark", "light"], default: "dark" },
    contrast: [65, 40, 100, 1],
  },
  typography: {
    font: {
      type: "select",
      options: [
        { value: "plex", label: "IBM Plex Mono" },
        { value: "menlo", label: "Menlo" },
        { value: "courier", label: "Courier" },
      ],
      default: "plex",
    },
    size: [13, 11, 18, 1],
    lineHeight: [1.8, 1.4, 2.2, 0.05],
  },
  layout: {
    arrangement: {
      type: "select",
      options: [
        "stream",
        "rail",
        "journal",
        "split",
        "focus",
        "review",
        "agents",
        "log",
        "dashboard",
      ],
      default: "stream",
    },
    padding: [28, 12, 44, 2],
    gap: [20, 8, 32, 2],
    chrome: true as boolean,
  },
  details: {
    activity: {
      type: "select",
      options: ["compact", "detailed", "hidden"],
      default: "compact",
    },
    timestamps: false as boolean,
    context: true as boolean,
    usage: true as boolean,
    diff: {
      type: "select",
      options: ["unified", "split", "summary"],
      default: "unified",
    },
    prompt: {
      type: "select",
      options: ["›", "❯", "λ", "$", ">", "▸"],
      default: "›",
    },
  },
  motion: {
    animation: {
      type: "select",
      options: ["fade", "pulse", "none"],
      default: "fade",
    },
    speed: [1, 0.5, 2, 0.1],
    reduced: false as boolean,
  },
} satisfies DialConfig;
export const FONTS: Record<string, string> = {
  plex: '"IBM Plex Mono", monospace',
  menlo: "Menlo, Monaco, monospace",
  courier: '"Courier New", monospace',
};
export function themeTokens(values: Look) {
  const mode = values.appearance.mode === "light" ? "light" : "dark";
  const palette = ["slate", "aiden", "moss", "berry"].includes(
    values.appearance.palette,
  )
    ? (values.appearance.palette as ThemePresetId)
    : "slate";
  const variant = {
    ...getPresetVariant(palette, mode),
    contrast: values.appearance.contrast,
    translucentSidebar: false,
  };
  return {
    ...resolveThemeTokens(variant, mode),
    "--focus-ring": variant.foreground,
  };
}
export interface SavedLook {
  id: string;
  name: string;
  directionId: string;
  look: Look;
  notes: string;
}
export function validLook(value: unknown): value is Look {
  if (!value || typeof value !== "object") return false;
  const v = value as Look;
  const choice = (value: unknown, options: string[]) =>
    typeof value === "string" && options.includes(value);
  const range = (value: unknown, min: number, max: number) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max;
  return (
    !!v.appearance &&
    !!v.typography &&
    !!v.layout &&
    !!v.details &&
    !!v.motion &&
    choice(v.appearance.palette, ["slate", "aiden", "moss", "berry"]) &&
    choice(v.appearance.mode, ["light", "dark"]) &&
    range(v.appearance.contrast, 40, 100) &&
    choice(v.typography.font, Object.keys(FONTS)) &&
    range(v.typography.size, 11, 18) &&
    range(v.typography.lineHeight, 1.4, 2.2) &&
    choice(v.layout.arrangement, [
      "stream",
      "rail",
      "journal",
      "split",
      "focus",
      "review",
      "agents",
      "log",
      "dashboard",
    ]) &&
    range(v.layout.padding, 12, 44) &&
    range(v.layout.gap, 8, 32) &&
    typeof v.layout.chrome === "boolean" &&
    choice(v.details.activity, ["compact", "detailed", "hidden"]) &&
    choice(v.details.diff, ["unified", "split", "summary"]) &&
    choice(v.details.prompt, ["›", "❯", "λ", "$", ">", "▸"]) &&
    ["timestamps", "context", "usage"].every(
      (key) => typeof v.details[key as "usage"] === "boolean",
    ) &&
    choice(v.motion.animation, ["fade", "pulse", "none"]) &&
    range(v.motion.speed, 0.5, 2) &&
    typeof v.motion.reduced === "boolean"
  );
}
export function loadSaved(): SavedLook[] {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem("aiden-cli-studio:v1:saved") ?? "[]",
    );
    return Array.isArray(raw)
      ? raw
          .filter(
            (v): v is SavedLook =>
              !!v &&
              typeof v.id === "string" &&
              typeof v.name === "string" &&
              v.name.length <= 80 &&
              typeof v.notes === "string" &&
              v.notes.length <= 2000 &&
              DIRECTIONS.some((d) => d.id === v.directionId) &&
              validLook(v.look),
          )
          .slice(0, 30)
      : [];
  } catch {
    return [];
  }
}
export function exportBrief(direction: Direction, values: Look, notes: string) {
  return {
    format: "aiden-cli-design-brief",
    version: 1,
    direction: { id: direction.id, name: direction.name },
    settings: values,
    notes,
    scope: "Proposal only. Do not apply until the user approves.",
    implementation: {
      theme: "Use renderer/shared/appearance.ts and regenerate CLI themes.",
      layout:
        "Changes to the Pi TUI renderers/extensions require implementation.",
      terminal:
        "Font family, size, and line height are terminal-emulator settings; shown here for evaluation.",
      window:
        "Window chrome is a browser preview aid, not a CLI-rendered title bar.",
      safety:
        "Keep approvals, access tiers, secret handling, and networking behavior unchanged.",
    },
  };
}
