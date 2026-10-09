import { compileAum } from "../../renderer/shared/aiden-ui/compile.js";
import { AIDEN_UI_CATALOG_VERSION } from "../../renderer/shared/aiden-ui/types.js";
import { parseChatUiVisualV1 } from "../../renderer/shared/aiden-ui/visual.js";
import type { ChatArtifactEventV1 } from "../../renderer/shared/chat-artifacts.js";
import { GENERATIVE_UI_DRAFT_THROTTLE_MS, isHtmlArtifactTitle, RENDER_UI_TOOL_NAME } from "../../renderer/shared/generative-ui.js";

/**
 * Streams in-flight `render_ui` calls as draft trees. Partial markup is
 * compiled tolerantly (open elements auto-close) at most every 250 ms per
 * call, so the visual grows in its row while the model is still writing it.
 */

export interface UiDraftSessionOptions {
  enabled?: boolean;
  publicToolCallId: (rawToolCallId: string) => string | undefined;
  send: (event: ChatArtifactEventV1) => void;
  schedule?: (run: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
  throttleMs?: number;
}

interface UiDraftCall {
  latestArgs?: unknown;
  timer?: unknown;
  publicId?: string;
  /** The last compiled draft sent, to skip unchanged recompiles. */
  lastSent?: string;
  stopped: boolean;
}

export function createUiDraftSession(options: UiDraftSessionOptions) {
  const schedule = options.schedule ?? ((run, delayMs) => setTimeout(run, delayMs));
  const cancelScheduled =
    options.cancelScheduled ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const throttleMs = options.throttleMs ?? GENERATIVE_UI_DRAFT_THROTTLE_MS;
  const calls = new Map<string, UiDraftCall>();

  const apply = (rawToolCallId: string) => {
    const call = calls.get(rawToolCallId);
    if (!call || call.stopped) return;
    call.timer = undefined;
    call.publicId ??= options.publicToolCallId(rawToolCallId);
    if (!call.publicId) return;
    const args = call.latestArgs as { title?: unknown; markup?: unknown; layout?: unknown } | undefined;
    if (!args || typeof args.markup !== "string" || !args.markup.trim()) return;
    const compiled = compileAum(args.markup, { draft: true });
    if (!compiled.tree) return;
    const title = typeof args.title === "string" && isHtmlArtifactTitle(args.title) ? args.title : compiled.title ?? "Visualizing";
    const visual = parseChatUiVisualV1({
      version: 1,
      kind: "ui",
      id: `draft-${call.publicId}`,
      toolCallId: call.publicId,
      title: isHtmlArtifactTitle(title) ? title : "Visualizing",
      catalogVersion: AIDEN_UI_CATALOG_VERSION,
      tree: compiled.tree,
      ...(compiled.dataJson ? { dataJson: compiled.dataJson } : {}),
      ...(compiled.state ? { state: compiled.state } : {}),
      fallbackText: compiled.fallbackText,
      ...(args.layout === "wide" ? { layout: "wide" } : {}),
    });
    if (!visual) return;
    const serialized = JSON.stringify(visual);
    if (serialized === call.lastSent) return;
    call.lastSent = serialized;
    options.send({ version: 1, operation: "ui_draft", toolCallId: call.publicId, visual });
  };

  const stop = (call: UiDraftCall, retract: boolean) => {
    if (call.timer !== undefined) cancelScheduled(call.timer);
    call.timer = undefined;
    call.stopped = true;
    if (retract && call.publicId && call.lastSent) {
      options.send({ version: 1, operation: "draft_end", toolCallId: call.publicId });
    }
  };

  return {
    delta(rawToolCallId: string, toolName: string, args: unknown): void {
      if (options.enabled === false || toolName !== RENDER_UI_TOOL_NAME) return;
      let call = calls.get(rawToolCallId);
      if (!call) {
        call = { stopped: false };
        calls.set(rawToolCallId, call);
      }
      if (call.stopped) return;
      call.latestArgs = args;
      if (call.timer === undefined) call.timer = schedule(() => apply(rawToolCallId), throttleMs);
    },
    /** Arguments are complete: show the final draft until the visual is presented. */
    end(rawToolCallId: string): void {
      const call = calls.get(rawToolCallId);
      if (!call || call.stopped) return;
      if (call.timer !== undefined) cancelScheduled(call.timer);
      apply(rawToolCallId);
      stop(call, false);
    },
    /** The call will not present a visual: retract its draft. */
    cancel(rawToolCallId: string): void {
      const call = calls.get(rawToolCallId);
      if (!call) return;
      stop(call, true);
      calls.delete(rawToolCallId);
    },
    dispose(): void {
      for (const call of calls.values()) stop(call, true);
      calls.clear();
    },
  };
}
