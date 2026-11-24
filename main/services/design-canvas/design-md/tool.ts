/**
 * The `design_system` tool (spec §6.9 "Agent surface", R4, S36): read, lint,
 * export or draft an app's DESIGN.md. It never writes a file; Aiden writes
 * DESIGN.md with write_file under the workspace's ordinary approvals.
 *
 * Everything taken from the file (token names and values, headings, finding
 * messages, exports, drafts) reaches Aiden only inside `fenceAsData` (S11).
 * The JSON head of each answer holds only statuses, checked paths and counts.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { fenceAsData } from "../../../../renderer/shared/agent-notices.js";
import { isPathInside } from "../../../shared/path-containment.js";
import { declarePiRuntimeReplay } from "../../pi-runtime-tool.js";
import { isSafeWorkspaceRelativePath, readCanvasConfig, type CanvasConfig } from "../canvas-config.js";
import { designMdDraftFor } from "./draft.js";
import type { DesignMdExportFormat } from "./lint-client.js";
import { createDesignAppRoots, DESIGN_MD_NAME, joinRelative, locateDesignMd, type DesignAppRoots } from "./locate.js";
import { DESIGN_MD_MAX_BYTES, type DesignMdReader, type DesignMdState } from "./reader.js";

export const DESIGN_SYSTEM_CALLS_PER_TURN = 20;
const MAX_FINDINGS = 50;
const MAX_SECTIONS = 40;
const MAX_EXPORT_BYTES = 64 * 1024;
const FORMATS = ["css-tailwind", "json-tailwind", "dtcg", "css-vars"] as const satisfies readonly DesignMdExportFormat[];
const ACTIONS = ["read", "lint", "export", "draft"] as const;
const NOTHING_WRITTEN =
  "Nothing was written. Show the person what you'll write, then write it with write_file once they've said yes.";

const enumOf = <T extends string>(values: readonly T[]) => Type.Unsafe<T>({ type: "string", enum: [...values] });

/** Fixed words for each status that carries no findings. */
const STATUS_WORDS: Record<string, string> = {
  missing: "There's no DESIGN.md for this app yet. design_system with action draft can start one.",
  invalid: "That DESIGN.md can't be used: it's outside the workspace or its path isn't safe.",
  "too-large": `This DESIGN.md is over ${DESIGN_MD_MAX_BYTES / 1024} KiB, so it isn't checked.`,
  unreadable: "This DESIGN.md can't be read.",
  "timed-out": "Checking this DESIGN.md took too long.",
  "lint-failed": "The DESIGN.md linter failed on this file.",
  "linter-unavailable": "The DESIGN.md linter isn't available right now.",
  busy: "The DESIGN.md linter is busy. Try again in a moment.",
};

export type DesignSystemToolDeps = {
  workspaceRoot: string;
  reader: Pick<DesignMdReader, "read" | "lintContent" | "export">;
  /** The turn's described app roots (R2); the first is the default `appRoot`. */
  appRoots?: DesignAppRoots;
  /** The workspace's `.aiden/canvas.json`, read fresh per call by default. */
  config?: () => Promise<CanvasConfig | null>;
  /** False once the chat left design mode, changed folder or lost access. Checked on every call. */
  stillAvailable?(): Promise<boolean>;
  draftFor?: (workspaceRoot: string, appRoot: string, signal?: AbortSignal) => Promise<string>;
  /** Told the target of each draft, for `design_md_drafted` (R7). */
  onDraft?(target: string): void;
};

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: null };

const answer = (headValue: Record<string, unknown>, ...rest: string[]): ToolResult => ({
  content: [{ type: "text", text: [JSON.stringify(headValue), ...rest].join("\n") }],
  details: null,
});

class DesignSystemToolError extends Error {}

/** A safe app root that exists as a real folder inside the workspace (R1); the IPC uses it too. */
export async function checkedAppRoot(workspaceRoot: string, value: unknown): Promise<string> {
  const refusal = 'appRoot must be "." or a workspace-relative folder such as apps/web, inside the workspace.';
  if (!isSafeWorkspaceRelativePath(value)) throw new DesignSystemToolError(refusal);
  try {
    const realRoot = await realpath(workspaceRoot);
    const folder = await realpath(path.join(realRoot, ...value.split("/")));
    if (!isPathInside(realRoot, folder) || !(await stat(folder)).isDirectory()) throw new DesignSystemToolError(refusal);
  } catch {
    throw new DesignSystemToolError(refusal);
  }
  return value;
}

function stateHead(state: DesignMdState, appRoot: string): Record<string, unknown> {
  const fileFields = "path" in state ? { path: state.path, source: state.source } : {};
  if (state.status === "ok") return { status: "ok", appRoot, ...fileFields, summary: state.summary };
  if (state.status === "missing") return { status: "missing", appRoot, searched: state.searched, message: STATUS_WORDS.missing };
  return {
    status: state.status,
    appRoot,
    ...fileFields,
    ...(state.status === "too-large" ? { bytes: state.size } : {}),
    message: STATUS_WORDS[state.status],
  };
}

const findingsList = (findings: Extract<DesignMdState, { status: "ok" }>["findings"]) =>
  findings.slice(0, MAX_FINDINGS).map((finding) => ({
    severity: finding.severity,
    ...(finding.rule ? { rule: finding.rule } : {}),
    ...(finding.path ? { path: finding.path } : {}),
    message: finding.message,
  }));

export function createDesignSystemTool(deps: DesignSystemToolDeps): AgentTool {
  const appRoots = deps.appRoots ?? createDesignAppRoots();
  const config = deps.config ?? (() => readCanvasConfig(deps.workspaceRoot));
  const draftFor = deps.draftFor ?? designMdDraftFor;
  let calls = 0;

  const run = async (body: () => Promise<ToolResult>): Promise<ToolResult> => {
    calls += 1;
    if (calls > DESIGN_SYSTEM_CALLS_PER_TURN) {
      return answer({
        status: "limit_reached",
        limit: DESIGN_SYSTEM_CALLS_PER_TURN,
        message: `This turn has used its ${DESIGN_SYSTEM_CALLS_PER_TURN} design_system calls. Do not retry: tell the person what you found and let them ask you to go on.`,
      });
    }
    if (deps.stillAvailable && !(await deps.stillAvailable())) {
      return answer({ status: "unavailable", reason: "Design mode is off in this chat." });
    }
    try {
      return await body();
    } catch (error) {
      if (error instanceof DesignSystemToolError) return answer({ status: "error", message: error.message });
      throw error;
    }
  };

  return declarePiRuntimeReplay(
    {
      name: "design_system",
      label: "Design system",
      description:
        "Read, check, export or draft the app's DESIGN.md, the design system's source of truth: its tokens, sections and lint findings, its Tailwind, DTCG or CSS-variable export, or a starter draft from the app's own styles. It never writes files; write DESIGN.md yourself with write_file after the person agrees.",
      parameters: Type.Object({
        action: enumOf(ACTIONS),
        appRoot: Type.Optional(
          Type.String({ maxLength: 200, description: 'The app\'s folder, workspace-relative ("." for the root). Defaults to the app the canvas note names first.' }),
        ),
        format: Type.Optional(enumOf(FORMATS)),
        content: Type.Optional(
          Type.String({ maxLength: DESIGN_MD_MAX_BYTES, description: "lint only: DESIGN.md text to check before you write it." }),
        ),
      }),
      execute: async (_id, raw, signal) =>
        run(async () => {
          const p = (raw ?? {}) as { action?: unknown; appRoot?: unknown; format?: unknown; content?: unknown };
          if (!(ACTIONS as readonly unknown[]).includes(p.action)) {
            throw new DesignSystemToolError(`action must be one of ${ACTIONS.join(", ")}.`);
          }
          const action = p.action as (typeof ACTIONS)[number];

          if (action === "lint" && p.content !== undefined) {
            if (typeof p.content !== "string") throw new DesignSystemToolError("content must be DESIGN.md text.");
            const state = await deps.reader.lintContent(p.content, signal);
            if (state.status !== "ok") {
              return answer({
                status: state.status,
                source: "content",
                ...(state.status === "too-large" ? { bytes: state.size } : {}),
                message: STATUS_WORDS[state.status],
              });
            }
            const findings = findingsList(state.findings);
            return answer(
              { status: "ok", source: "content", summary: state.summary, findingsShown: findings.length },
              fenceAsData("Findings for the DESIGN.md text you gave", JSON.stringify(findings)),
            );
          }

          const currentConfig = await config();
          const appRoot =
            p.appRoot === undefined || p.appRoot === ""
              ? ((await appRoots(deps.workspaceRoot, { signal, config: currentConfig })).roots[0] ?? ".")
              : p.appRoot;
          const root = await checkedAppRoot(deps.workspaceRoot, appRoot);
          const located = await locateDesignMd(deps.workspaceRoot, root, currentConfig, { signal });

          if (action === "draft") {
            if (!("missing" in located)) {
              if ("invalid" in located) return answer({ status: "invalid", appRoot: root, message: STATUS_WORDS.invalid });
              return answer({
                status: "exists",
                appRoot: root,
                path: located.path,
                message: "This app already has a DESIGN.md. Call design_system with action read instead.",
              });
            }
            const override = currentConfig?.apps.find((entry) => entry.root === root && entry.designMd)?.designMd;
            const target = override ?? joinRelative(root, DESIGN_MD_NAME);
            const draft = await draftFor(deps.workspaceRoot, root, signal);
            const checked = await deps.reader.lintContent(draft, signal);
            deps.onDraft?.(target);
            return answer(
              {
                status: "drafted",
                appRoot: root,
                target,
                ...(checked.status === "ok" ? { summary: checked.summary } : { lint: checked.status }),
              },
              fenceAsData(`Draft DESIGN.md for ${JSON.stringify(target)}`, draft),
              NOTHING_WRITTEN,
            );
          }

          if (action === "export") {
            const format = p.format ?? "css-tailwind";
            if (!(FORMATS as readonly unknown[]).includes(format)) {
              throw new DesignSystemToolError(`format must be one of ${FORMATS.join(", ")}.`);
            }
            const state = await deps.reader.export(deps.workspaceRoot, located, format as DesignMdExportFormat, signal);
            if (state.status === "ok") {
              const bytes = Buffer.byteLength(state.text);
              if (bytes > MAX_EXPORT_BYTES) {
                return answer({
                  status: "too-large",
                  appRoot: root,
                  path: state.path,
                  format,
                  bytes,
                  message: `This export is ${bytes} bytes, over the ${MAX_EXPORT_BYTES / 1024} KiB limit, so it isn't shown. Export a smaller format or read the tokens instead.`,
                });
              }
              return answer(
                { status: "ok", appRoot: root, path: state.path, format, bytes },
                fenceAsData(`${format} export of ${JSON.stringify(state.path)}`, state.text),
              );
            }
            if (state.status === "error") {
              return answer(
                { status: "error", appRoot: root, path: state.path, format, message: "The export failed; the reasons follow." },
                fenceAsData(`Export errors for ${JSON.stringify(state.path)}`, JSON.stringify(state.errors)),
              );
            }
            return answer({ ...stateHead(state, root), format });
          }

          const state = await deps.reader.read(deps.workspaceRoot, located, { signal });
          if (state.status !== "ok") return answer(stateHead(state, root));
          if (action === "lint") {
            const findings = findingsList(state.findings);
            return answer(
              { ...stateHead(state, root), findingsShown: findings.length },
              fenceAsData(`DESIGN.md findings for ${JSON.stringify(state.path)}`, JSON.stringify(findings)),
            );
          }
          return answer(
            { ...stateHead(state, root), truncated: state.truncated, sectionCount: state.sections.length },
            fenceAsData(
              `DESIGN.md tokens and sections from ${JSON.stringify(state.path)}`,
              JSON.stringify({ sections: state.sections.slice(0, MAX_SECTIONS), omitted: state.omitted, tokens: state.tokens }),
            ),
          );
        }),
    },
    "safe",
  );
}
