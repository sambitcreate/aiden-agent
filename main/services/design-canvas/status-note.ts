import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { withCanvasStatusNote } from "../../../renderer/shared/design-canvas/canvas-summary.js";
import { appendPiMessages } from "../pi-compaction-session-store.js";
import type { PiSessionPort } from "../pi-session-port.js";

/**
 * Adds the canvas status note to a design turn's starting transcript, so the
 * turn's first request carries the counts, and journals it after the history
 * it follows. The next turn rebuilds the same transcript from the journal, so
 * an unchanged count adds nothing and the prompt cache holds. The journal is
 * model context only; the visible chat, phone and Remote never show it.
 *
 * A note the journal could not take still goes to this turn's request:
 * `onJournalError` hears why.
 */
export async function withJournaledCanvasStatusNote(
  session: PiSessionPort,
  messages: readonly AgentMessage[],
  line: string,
  now: number,
  onJournalError: (error: unknown) => void,
): Promise<AgentMessage[]> {
  const noted = withCanvasStatusNote({ messages }, line, now).messages;
  if (noted === messages) return [...messages];
  const note = noted[noted.length - 1] as AgentMessage;
  try {
    await appendPiMessages(session, [note]);
  } catch (error) {
    onJournalError(error);
  }
  return [...messages, note];
}
