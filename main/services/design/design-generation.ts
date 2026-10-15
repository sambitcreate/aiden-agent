// What llmClient does differently for a design run, in one tested place: the
// composition (one extension, no Aiden system prompt, no mid-flight input), the
// storage redaction, and the outcome a finished generation reports to the run
// (ADR-DS §1, §4, §10).
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { GenerationCancellationOrigin } from "../../../renderer/shared/generation-timeline.js";
import type { DesignRunBinding } from "../generation-profile.js";
import type { PiAgentRuntimeExtension, PiRuntimeTerminalOutcome } from "../pi-agent-runtime-harness.js";
import type { PiSessionPort } from "../pi-session-port.js";
import { redactDesignMessageForStorage } from "./design-context-core.js";
import type { DesignRunOutcome } from "./store-core.js";

type AppendPiMessages = (
  session: PiSessionPort,
  messages: readonly AgentMessage[],
  visibleChatMessageId?: string,
) => Promise<void>;

export interface DesignGenerationWiring {
  /** The binding's render extension and nothing else; createGenerationHarness enforces it. */
  extensions: readonly PiAgentRuntimeExtension[];
  /** No Aiden persona or tool guidance: the render extension supplies the whole system prompt. */
  baseSystemPrompt: string;
  /** A design run takes no steer and no queued follow-up. */
  inputClosed: boolean;
  /** Pi journal writes keep each render_artifact's call id and title, not its HTML. */
  journalAppend: AppendPiMessages;
  /** The assistant message stored on the hidden chat, redacted the same way. */
  storedAssistantMessage<T extends AgentMessage>(message: T): T;
}

/** The project store holds the HTML, so neither the journal nor the hidden chat keeps it. */
export function designGenerationWiring(
  binding: Pick<DesignRunBinding, "extension">,
  appendMessages: AppendPiMessages,
): DesignGenerationWiring {
  return {
    extensions: [binding.extension],
    baseSystemPrompt: "",
    inputClosed: true,
    journalAppend: (session, messages, visibleChatMessageId) =>
      appendMessages(
        session,
        messages.map((message) => redactDesignMessageForStorage(message)),
        visibleChatMessageId,
      ),
    storedAssistantMessage: (message) => redactDesignMessageForStorage(message),
  };
}

export interface DesignGenerationEnd {
  runtimeKind: PiRuntimeTerminalOutcome["kind"];
  /** The runtime ended on an emergency context projection. */
  emergency: boolean;
  /** A Stop, a deletion, a setting change or the app quitting cancelled the run. */
  cancelled: boolean;
  cancellationOrigin?: GenerationCancellationOrigin;
  /** The final assistant message could not be stored on the hidden chat. */
  persistenceFailed: boolean;
}

/**
 * The outcome a finished design generation reports. A failure the runtime
 * reports comes first, as llmClient shows it before a cancellation. An app quit
 * interrupts the run (so it ends like a restart) rather than stopping it, and a
 * reply that could not be saved is Aiden's failure, not the provider's.
 */
export function designRunOutcome(end: DesignGenerationEnd): DesignRunOutcome {
  if (end.runtimeKind === "provider_failed") return "failed";
  if (end.runtimeKind === "host_failed" || end.emergency) return "host_failed";
  if (end.cancelled) return end.cancellationOrigin === "application_shutdown" ? "interrupted" : "cancelled";
  return end.persistenceFailed ? "host_failed" : "completed";
}
