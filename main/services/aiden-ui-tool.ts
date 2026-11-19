import { createHash } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { compileAum } from "../../renderer/shared/aiden-ui/compile.js";
import {
  AIDEN_UI_CATALOG_VERSION,
  AIDEN_UI_LIMITS,
  type AidenUiDiagnostic,
  type ChatUiVisualV1,
} from "../../renderer/shared/aiden-ui/types.js";
import { parseChatUiVisualV1 } from "../../renderer/shared/aiden-ui/visual.js";
import { RENDER_UI_TOOL_NAME } from "../../renderer/shared/generative-ui.js";
import { requireGenerativeUiTitle } from "./generative-ui-html.js";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import { declareOnDemandSummary } from "./on-demand-tools.js";
import { applyMarkupEdits, MAX_MARKUP_EDITS, parseMarkupEdits } from "./markup-edits.js";
import { checkWorkspaceArtifactPage } from "./workspace-artifacts/check.js";
import { formatCheckReport } from "./check-report.js";

export { RENDER_UI_TOOL_NAME };

/** Markup longer than this cannot compile under the tree and data caps anyway. */
const MAX_MARKUP_CHARS = 400_000;
const MAX_REPORTED_DIAGNOSTICS = 12;

export interface RenderUiToolOptions {
  /** Unique per generation, so visual ids never collide across responses. */
  namespace: string;
  existingChatUiCount: number;
  onUiVisual: (visual: ChatUiVisualV1, context: { toolCallId: string }) => boolean | void | Promise<boolean | void>;
}

/**
 * Draws the visual against its own data the way the chat does, so a misspelt
 * field or a list read as an object comes back as a finding instead of a
 * blank chart the tool called a success.
 */
function describeVisualCheck(visual: ChatUiVisualV1): string {
  const check = checkWorkspaceArtifactPage({ visual, sources: [], actions: [] }, undefined);
  if (!check.findings.length) return "";
  return formatCheckReport({
    label: "Visual check",
    findings: check.findings,
    fix: "These draw empty; fix them and call render_ui again with the same title to replace the visual.",
  });
}

function describeDiagnostics(diagnostics: readonly AidenUiDiagnostic[]): string {
  if (diagnostics.length === 0) return "";
  const lines = diagnostics.slice(0, MAX_REPORTED_DIAGNOSTICS).map((diagnostic) => `- ${diagnostic.code}: ${diagnostic.message}`);
  if (diagnostics.length > MAX_REPORTED_DIAGNOSTICS) lines.push(`- …and ${diagnostics.length - MAX_REPORTED_DIAGNOSTICS} more`);
  return `\nRepairs Aiden made (the visual shows with them; if one changed what you meant, call render_ui again with the same title to replace it, and avoid them from now on):\n${lines.join("\n")}`;
}

/**
 * `render_ui`: the model composes a visual from Aiden's native component
 * catalog in Aiden UI Markup. The host compiles, repairs, and validates it;
 * only the compiled tree is kept, and the result tells the model what was
 * repaired so it can do better on its next call.
 */
export function createRenderUiTool(options: RenderUiToolOptions): AgentTool {
  /** Each visual drawn in this response, by title, with the markup and layout it was last drawn with. */
  const titles = new Map<string, { id: string; toolCallId: string; markup: string; layout: "column" | "wide" }>();
  let presentedCount = 0;
  let serial = Promise.resolve();

  return declareOnDemandSummary(
    declarePiRuntimeReplay(
    {
      name: RENDER_UI_TOOL_NAME,
      label: "Render Visual",
      description:
        "Draw a visual inside your reply with Aiden's own native components (charts, stats, tables, comparisons, checklists, steps, timelines, and simple interactive filters, tabs, and sliders). Write Aiden UI Markup: JSX-like catalog elements, {expressions} over <Data> and <Visual state={{…}}>, and actions like sendPrompt(\"…\"). Read visualize_guide with the catalog module first. Prefer this over render_artifact unless you need custom drawing or scripting.",
      parameters: Type.Object({
        title: Type.String({ description: "Short visible title; also the visual's alt text.", minLength: 1, maxLength: 120 }),
        layout: Type.Optional(
          Type.Union([Type.Literal("column"), Type.Literal("wide")], {
            description:
              "Set before markup. column (default): the reading column, about 690px. wide: spans the chat pane (up to about 1280px) for dashboards and wide tables.",
          }),
        ),
        markup: Type.Optional(
          Type.String({
            description:
              "Aiden UI Markup, starting with <Visual title=\"…\">. Put data in <Data name=\"data\">{json}</Data> and read it as $data. Required unless edits redraws a visual drawn earlier in this reply.",
            minLength: 1,
            maxLength: MAX_MARKUP_CHARS,
          }),
        ),
        edits: Type.Optional(
          Type.Array(
            Type.Object({
              old: Type.String({ description: "Exact text from the markup the visual was last drawn from, matching one place only.", minLength: 1 }),
              new: Type.String({ description: "The text to put in its place; \"\" removes it." }),
            }),
            {
              description:
                "Instead of markup, to redraw a visual drawn earlier in this reply with the same title: replacements applied in order to the markup it was last drawn from, keeping its layout unless layout is set. All or nothing: if any old text is missing or matches more than one place, nothing is drawn and the error names that edit.",
              minItems: 1,
              maxItems: MAX_MARKUP_EDITS,
            },
          ),
        ),
      }),
      execute: async (toolCallId, params, signal): Promise<AgentToolResult<null>> => {
        const previous = serial;
        let release!: () => void;
        serial = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          if (signal?.aborted) throw new Error("Rendering the visual was cancelled.");
          const input = params as { title?: unknown; layout?: unknown; markup?: unknown; edits?: unknown };
          const title = requireGenerativeUiTitle(input.title);
          if (input.layout !== undefined && input.layout !== "column" && input.layout !== "wide") {
            throw new Error('render_ui layout must be "column" or "wide".');
          }
          let markup = input.markup;
          const requestedLayout = input.layout as "column" | "wide" | undefined;
          let layout = requestedLayout ?? "column";
          if (input.edits !== undefined) {
            if (markup !== undefined) throw new Error("render_ui takes either markup or edits, not both.");
            const earlier = titles.get(title);
            if (!earlier) {
              throw new Error(`render_ui edits redraw a visual drawn earlier in this reply, and none is titled ${JSON.stringify(title)}; send the whole markup.`);
            }
            const edited = applyMarkupEdits(earlier.markup, parseMarkupEdits(input.edits), "Send the edits again against the markup you last drew, or the whole markup.");
            // A redraw from edits keeps the layout the visual was drawn with.
            layout = requestedLayout ?? earlier.layout;
            if (edited.length > MAX_MARKUP_CHARS) {
              throw new Error(
                `render_ui edits made the markup too long: ${edited.length.toLocaleString("en-US")} characters, over the ${MAX_MARKUP_CHARS.toLocaleString("en-US")} a visual can be. Nothing was drawn; send edits that remove more than they add, or shorter whole markup.`,
              );
            }
            markup = edited;
          }
          if (typeof markup !== "string") throw new Error("render_ui needs markup.");
          if (markup.length > MAX_MARKUP_CHARS) {
            throw new Error(`render_ui markup is too long: ${markup.length.toLocaleString("en-US")} characters, over the ${MAX_MARKUP_CHARS.toLocaleString("en-US")} a visual can be.`);
          }
          const compiled = compileAum(markup);
          if (!compiled.tree) {
            throw new Error(`render_ui produced no visual.${describeDiagnostics(compiled.diagnostics)}`);
          }
          const replacing = titles.get(title);
          if (!replacing) {
            if (presentedCount >= AIDEN_UI_LIMITS.perResponse) {
              throw new Error(`Up to ${AIDEN_UI_LIMITS.perResponse} visuals can be drawn in one response.`);
            }
            if (options.existingChatUiCount + presentedCount >= AIDEN_UI_LIMITS.perChat) {
              throw new Error(`This chat has reached its ${AIDEN_UI_LIMITS.perChat}-visual limit.`);
            }
          }
          const id =
            replacing?.id ??
            `ui-${createHash("sha256").update(options.namespace).update("\0").update(toolCallId).digest("hex").slice(0, 40)}`;
          const visual = parseChatUiVisualV1({
            version: 1,
            kind: "ui",
            id,
            title,
            catalogVersion: AIDEN_UI_CATALOG_VERSION,
            tree: compiled.tree,
            ...(compiled.dataJson ? { dataJson: compiled.dataJson } : {}),
            ...(compiled.state ? { state: compiled.state } : {}),
            fallbackText: compiled.fallbackText,
            ...(layout === "wide" ? { layout: "wide" } : {}),
          });
          if (!visual) throw new Error("render_ui produced a visual Aiden cannot store; simplify it.");
          if (signal?.aborted) throw new Error("Rendering the visual was cancelled.");
          const placementCallId = replacing?.toolCallId ?? toolCallId;
          const presented = (await options.onUiVisual(visual, { toolCallId: placementCallId })) !== false;
          if (presented && !replacing) {
            presentedCount += 1;
            titles.set(title, { id, toolCallId, markup, layout });
          } else if (presented && replacing) {
            replacing.markup = markup;
            replacing.layout = layout;
          }
          const nodes = JSON.stringify(visual.tree).match(/"t":/gu)?.length ?? 0;
          return {
            content: [
              {
                type: "text",
                text: replacing && !presented
                  ? `Aiden could not show this redraw of the visual "${title}" (${nodes} components); the person still sees the version drawn earlier in this reply, and later edits apply to that version's markup.`
                  : `${replacing ? `Replaced the visual "${title}" in place; the person now sees this version` : `Rendered visual "${title}"`} (${nodes} components).${describeDiagnostics(compiled.diagnostics)}${describeVisualCheck(visual)}`,
              },
            ],
            details: null,
          };
        } finally {
          release();
        }
      },
    },
    "never",
    ),
    "Draw charts, stats, tables or checklists inside your reply with Aiden's own components; use when a visual answers better than prose.",
  );
}

/** Ui visuals already on the chat count toward its 60-visual limit. */
export function displayedAssistantUiCount(messages: readonly { role: string; uiVisuals?: readonly unknown[] }[]): number {
  return messages.reduce((total, message) => total + (message.role === "assistant" ? message.uiVisuals?.length ?? 0 : 0), 0);
}
