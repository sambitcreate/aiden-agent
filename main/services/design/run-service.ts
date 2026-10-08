// Starts design runs on a project's hidden chat through llmClient.start
// (ADR-DS §1). The renderer never calls chat:start for a project chat.
import { isAcpHarnessProvider } from "../../../renderer/shared/acp-harness.js";
import { RENDER_ARTIFACT_TOOL_NAME } from "../../../renderer/shared/generative-ui.js";
import type {
  DesignContextChip,
  DesignModelRef,
  DesignProjectSnapshot,
  DesignRunChangedEvent,
  DesignRunRecord,
  DesignRunStartRequest,
  DesignRunStartResult,
} from "../../../renderer/shared/design/types.js";
import { appendChatMessageWithReconciliation } from "../chat-append-commit.js";
import type { ChatGenerationOwner } from "../chat-generation-owner.js";
import type { ChatTurnLease } from "../chat-turn-admission.js";
import type { DesignRunBinding } from "../generation-profile.js";
import type { PiRuntimeEffectStore } from "../pi-runtime-effect-store.js";
import type { ChatStartParams } from "../types.js";
import type { DesignChatAccess } from "./chat-port.js";
import {
  buildDesignContextBlock,
  designContextRefusal,
  redactDesignMessageForStorage,
  type DesignContextTarget,
} from "./design-context-core.js";
import { createDesignRenderExtension } from "./design-render-extension.js";
import { planDesignRun, type DesignRunOutcome, type DesignRunPlan } from "./store-core.js";
import type { DesignProjectStore } from "./store.js";

export interface DesignGenerationOptions {
  usageSource: "design";
  turnId: string;
  allowSubagents: false;
  allowComputerUse: false;
  allowMcpTools: false;
  onTurnAccepted: () => void;
  designRun: DesignRunBinding;
}

export interface DesignRunServiceDeps {
  store: Pick<
    DesignProjectStore,
    "get" | "ensureChat" | "beginRun" | "acceptRunArtifact" | "finishRun" | "readRevision" | "revisionIdForToolCall"
  >;
  chats: Pick<DesignChatAccess, "get" | "appendUserMessage">;
  /** piRuntimeEffectStore in production: the ledger llmClient turns into recovery boundaries. */
  effects: Pick<PiRuntimeEffectStore, "listEffectsNeedingRecoveryByChat" | "markRecoveryRecorded">;
  generation: {
    beginChatTurn(chatId: string, turnId: string, ownerId: string): ChatTurnLease | null;
    start(
      streamId: string,
      params: ChatStartParams,
      owner: ChatGenerationOwner,
      options: DesignGenerationOptions,
    ): Promise<boolean>;
  };
  notifyRunChanged(event: DesignRunChangedEvent): void;
  newId(): string;
  onError?(message: string, error: unknown): void;
}

export type DesignRunStartInput = DesignRunStartRequest & { owner: ChatGenerationOwner };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A Resume defaults to the model of the set it resumes; every other run names its model. */
function runModel(input: DesignRunStartRequest, plan: DesignRunPlan): DesignModelRef {
  if (input.providerId !== undefined && input.model !== undefined) {
    return { providerId: input.providerId, model: input.model };
  }
  if (plan.model) return { ...plan.model };
  throw new Error("Choose a model for this design run.");
}

function contextTargets(snapshot: DesignProjectSnapshot, chips: readonly DesignContextChip[]): DesignContextTarget[] {
  return chips.map((chip) => {
    const screen = snapshot.screens[chip.screenId];
    const revision = snapshot.revisions[chip.revisionId];
    if (!screen || !revision || revision.screenId !== screen.id) {
      throw new Error("A selected Screen changed. Select it again and retry.");
    }
    return {
      screenTitle: screen.title,
      revisionId: revision.id,
      ...(chip.kind === "element" ? { element: chip.element } : {}),
    };
  });
}

export class DesignRunService {
  private readonly settlements = new Set<Promise<void>>();

  constructor(private readonly deps: DesignRunServiceDeps) {}

  /** Never throws: every refusal and failure is returned as a user-visible error. */
  async start(input: DesignRunStartInput): Promise<DesignRunStartResult> {
    const { projectId } = input;
    const snapshot = this.deps.store.get(projectId);
    if (!snapshot) return { accepted: false, error: "This design project no longer exists." };
    const resumeRunId = input.request.op === "explore" ? input.request.resumeRunId : undefined;
    let plan: DesignRunPlan;
    let model: DesignModelRef;
    let contextText: string;
    try {
      // A Resume's cap, set and titles are recomputed from the manifest now, at click time.
      plan = planDesignRun(snapshot, input.request);
      model = runModel(input, plan);
      // An agent runtime hosts only interactive chat turns and would fail at its first request.
      if (isAcpHarnessProvider(model.providerId)) {
        return { accepted: false, error: "Agent-backed models cannot render designs. Choose another model." };
      }
      const base =
        plan.baseRevisionId === undefined
          ? undefined
          : { revisionId: plan.baseRevisionId, ...(await this.deps.store.readRevision(projectId, plan.baseRevisionId)) };
      const context = buildDesignContextBlock({
        request: input.request,
        cap: plan.cap,
        targets: contextTargets(snapshot, input.chips),
        existingDirections: plan.existingTitles ?? [],
        ...(base ? { base: { revisionId: base.revisionId, title: base.title, html: base.html } } : {}),
      });
      // Refused before any chat write or provider request (ADR-DS §4).
      if (!context.ok) return { accepted: false, error: designContextRefusal(context) };
      contextText = context.text;
    } catch (error) {
      return { accepted: false, error: errorMessage(error) };
    }

    let chatId: string;
    let prompt = input.prompt;
    try {
      chatId = await this.deps.store.ensureChat(projectId);
      if (resumeRunId !== undefined) {
        // A Resume asks again with the resumed run's own brief, verbatim.
        const brief = await this.resumeBrief(chatId, snapshot.runs[resumeRunId]!);
        if (brief === undefined) {
          return { accepted: false, error: "This run's brief is no longer available. Start a new Explore instead." };
        }
        prompt = brief;
      }
    } catch (error) {
      return { accepted: false, error: errorMessage(error) };
    }
    const turnId = input.streamId;
    const turn = this.deps.generation.beginChatTurn(chatId, turnId, input.owner.documentId);
    if (!turn) return { accepted: false, error: "This project already has a design run in progress." };

    const runId = this.deps.newId();
    let accepted = false;
    let runRecorded = false;
    try {
      turn.onReleased(input.owner.onInvalidated(turn.release));
      turn.reserveAppendPayload(Buffer.byteLength(prompt, "utf8") + 1_024);
      const messageId = `message_${this.deps.newId()}`;
      await appendChatMessageWithReconciliation({
        messageId,
        append: () =>
          this.deps.chats.appendUserMessage(chatId, {
            id: messageId,
            content: prompt,
            providerId: model.providerId,
            model: model.model,
            isCurrent: () => turn.isActive(),
          }),
        recover: () => this.deps.chats.get(chatId),
      });
      // ADR-DS §2 run ordering: the user message, then the run record, then the provider.
      const begun = await this.deps.store.beginRun(projectId, {
        runId,
        turnId,
        request: input.request,
        promptMessageId: messageId,
      });
      runRecorded = true;
      if (begun.cap !== plan.cap) {
        // The set changed between the click and the project gate; the disclosed cap no longer holds.
        throw new Error("This direction set changed. Review it and try again.");
      }
      await this.acknowledgeRenderEffects(chatId);
      turn.settleAsyncWork();
      const render = createDesignRenderExtension({
        request: input.request,
        cap: plan.cap,
        contextText,
        existingTitles: plan.existingTitles ?? [],
        accept: async (artifact) => {
          const result = await this.deps.store.acceptRunArtifact(projectId, runId, {
            ...artifact,
            model: { ...model },
          });
          this.publishRun(projectId, runId);
          return result;
        },
        revisionForToolCall: (toolCallId) => this.deps.store.revisionIdForToolCall(projectId, toolCallId),
      });
      const binding: DesignRunBinding = {
        projectId,
        runId,
        extension: render.extension,
        acceptedCount: () => render.state().accepted,
        redactForStorage: redactDesignMessageForStorage,
        onSettled: (outcome) => this.track(this.settle(projectId, runId, outcome)),
      };
      const started = await this.deps.generation.start(
        input.streamId,
        {
          chatId,
          providerId: model.providerId,
          model: model.model,
          ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
          messages: [],
        },
        input.owner,
        {
          usageSource: "design",
          turnId,
          allowSubagents: false,
          allowComputerUse: false,
          allowMcpTools: false,
          onTurnAccepted: () => {
            accepted = true;
          },
          designRun: binding,
        },
      );
      if (!started) {
        if (!accepted) turn.release();
        await this.settle(projectId, runId, "cancelled");
        return { accepted, runId, error: "The design run stopped before it began." };
      }
      return { accepted: true, runId, outputCap: plan.cap, model: { ...model } };
    } catch (error) {
      // Once llmClient has accepted the turn it owns the chat lease. Its settlement,
      // though, comes only from a started run's completion: a start that throws,
      // before or after accepting the turn, never settles the run itself.
      if (!accepted) {
        turn.release();
        turn.settleAsyncWork();
      }
      // finishRun ends a run only while it is still running, so this cannot double-settle.
      if (runRecorded) await this.settle(projectId, runId, "failed");
      return { accepted, ...(runRecorded ? { runId } : {}), error: errorMessage(error) };
    }
  }

  /** The brief a run was started with, read back from the hidden chat by its message id. */
  private async resumeBrief(chatId: string, run: DesignRunRecord): Promise<string | undefined> {
    if (run.promptMessageId === undefined) return undefined;
    const chat = await this.deps.chats.get(chatId);
    const message = chat?.messages.find((candidate) => candidate.id === run.promptMessageId);
    return message?.role === "user" && message.content.trim().length > 0 ? message.content : undefined;
  }

  /**
   * The project manifest, not the Pi effect ledger, decides what a design run
   * renders: accepted designs are listed in its context, and a render a crash
   * lost was never counted. Recording the chat's settled render_artifact effects
   * before every design turn keeps llmClient from installing a "do not repeat"
   * boundary that would contradict a Resume.
   */
  private async acknowledgeRenderEffects(chatId: string): Promise<void> {
    for (const effect of await this.deps.effects.listEffectsNeedingRecoveryByChat(chatId)) {
      if (effect.toolName !== RENDER_ARTIFACT_TOOL_NAME) continue;
      await this.deps.effects.markRecoveryRecorded({
        effectId: effect.effectId,
        operationId: effect.operationId,
        runId: effect.runId,
        chatId: effect.chatId,
      });
    }
  }

  /** Wait for every run settlement this service has started recording. */
  async drain(): Promise<void> {
    while (this.settlements.size > 0) await Promise.all([...this.settlements]);
  }

  private track(settlement: Promise<void>): void {
    this.settlements.add(settlement);
    void settlement.finally(() => this.settlements.delete(settlement));
  }

  private async settle(projectId: string, runId: string, outcome: DesignRunOutcome): Promise<void> {
    try {
      const snapshot = await this.deps.store.finishRun(projectId, runId, outcome);
      this.publishRun(projectId, runId, snapshot);
    } catch (error) {
      this.deps.onError?.("Could not record the end of a design run.", error);
    }
  }

  private publishRun(projectId: string, runId: string, snapshot = this.deps.store.get(projectId)): void {
    const run = snapshot?.runs[runId];
    if (!run) return;
    this.deps.notifyRunChanged({ projectId, runId, status: run.status, acceptedRevisionIds: [...run.revisionIds] });
  }
}
