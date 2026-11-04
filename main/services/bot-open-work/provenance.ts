import { BOT_INTRO_REQUEST_PREFIX } from "../bot-runtime/bot-intro.js";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
import { BOT_PERSON_INPUT_KIND, BOT_ROUTINE_INPUT_KIND, parseBotRoutineInputOrigin, type BotRoutineInputOrigin } from "../bot-runtime/bot-input-entry.js";
import type { BotOpenWorkOrigin } from "./store.js";
export type BotOpenWorkRoutineOrigin = (botId: string, requestId: string, submissionId: string, origin?: BotRoutineInputOrigin) => Promise<{ routineId: string; runId: string } | undefined>;
/** Resolve only current placed host inputs. Transcript notices and arbitrary request prefixes confer no authority. */
export async function resolveBotOpenWorkOrigin(botId: string, call: BotToolCall, sourceIndex: number | undefined, routine: BotOpenWorkRoutineOrigin): Promise<BotOpenWorkOrigin> {
  call.signal.throwIfAborted();
  const requests = await call.runRequestIds?.();
  if (!requests?.length || requests.length > 64 || requests.some((request) => typeof request !== "string" || !request)) throw new Error("Open work needs a current accepted person request or routine.");
  const index = sourceIndex ?? (requests.length === 1 ? 0 : -1);
  if (!Number.isSafeInteger(index) || index < 0 || index >= requests.length) throw new Error("Choose sourceIndex for one of this run's current inputs.");
  const [submissions, entries] = await Promise.all([call.submissions(requests as string[]), call.entries()]);
  const record = submissions[index], requestId = requests[index]!;
  if (record?.type !== "input" || record.status !== "placed" || record.requestId !== requestId) throw new Error("This input is no longer active for Open work.");
  const entry = entries.find((candidate) => candidate.id === record.entry);
  if (!entry || entry.model?.[0]?.role !== "user") throw new Error("The source input could not be verified.");
  const hidden = entries.some((candidate) => {
    const data = candidate.data as { notice?: unknown; requestId?: unknown } | undefined;
    return candidate.kind === "aiden.bot-notice" && data?.notice === "hidden_input" && data.requestId === requestId;
  });
  if (hidden) throw new Error("Hidden and self-generated input cannot create Open work.");
  let origin: BotOpenWorkOrigin;
  if (entry.kind === BOT_ROUTINE_INPUT_KIND) {
    const rawOrigin = (entry.data as { routineOrigin?: unknown } | undefined)?.routineOrigin;
    const stored = parseBotRoutineInputOrigin(rawOrigin);
    if (rawOrigin !== undefined && !stored) throw new Error("This routine input has invalid host provenance.");
    if (stored && (stored.botId !== botId || stored.runId !== requestId)) throw new Error("The routine origin belongs to another request.");
    const accepted = await routine(botId, requestId, String(record.id), stored);
    if (!accepted) throw new Error("This input does not belong to an accepted person-created routine.");
    origin = { requestId, source: { kind: "routine", submissionId: String(record.id), entryId: String(entry.id), ...accepted } };
  } else if (entry.kind === "pi.user" || entry.kind === BOT_PERSON_INPUT_KIND) {
    // Reserved unattended prefixes cannot gain person authority by a forged plain entry.
    if (requestId.startsWith(BOT_INTRO_REQUEST_PREFIX) || /^(?:routine:|wake:|peer:)/u.test(requestId)) throw new Error("This input's host provenance is not a person request.");
    origin = { requestId, source: { kind: "person", submissionId: String(record.id), entryId: String(entry.id) } };
  } else throw new Error("This input cannot create Open work.");
  call.signal.throwIfAborted();
  return origin;
}
