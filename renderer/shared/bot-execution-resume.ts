export interface BotExecutionResumeStatus { requiresUnknownCostAcknowledgement: boolean; interruptedSubmissionId?: string; costReceiptId?: string }
export interface BotResumeAcknowledgement { acknowledgeUnknownCost?: true; expectedSubmissionId?: string; expectedCostReceiptId?: string }
export const BOT_UNKNOWN_COST_CONFIRMATION = "The cost of an earlier provider request is unconfirmed. Resuming may incur another charge. Known spending limits still apply.";
const sourceId = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,31}$/u.test(value);
const receiptId = (value: unknown): value is string => typeof value === "string" && /^cost_[a-f0-9]{64}$/u.test(value);
export function parseBotExecutionResumeStatus(value: unknown): BotExecutionResumeStatus {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "requiresUnknownCostAcknowledgement" && key !== "interruptedSubmissionId" && key !== "costReceiptId")) throw new Error("Invalid Bot resume status.");
  const row = value as BotExecutionResumeStatus;
  if (typeof row.requiresUnknownCostAcknowledgement !== "boolean" || (row.requiresUnknownCostAcknowledgement || row.interruptedSubmissionId !== undefined) && !sourceId(row.interruptedSubmissionId)) throw new Error("Invalid interrupted work identity.");
  if (row.requiresUnknownCostAcknowledgement ? !receiptId(row.costReceiptId) : row.costReceiptId !== undefined) throw new Error("Invalid unconfirmed cost identity.");
  return { requiresUnknownCostAcknowledgement: row.requiresUnknownCostAcknowledgement, ...(row.interruptedSubmissionId === undefined ? {} : { interruptedSubmissionId: row.interruptedSubmissionId }), ...(row.costReceiptId === undefined ? {} : { costReceiptId: row.costReceiptId }) };
}
export function parseBotResumeAcknowledgement(value: unknown): BotResumeAcknowledgement {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "acknowledgeUnknownCost" && key !== "expectedSubmissionId" && key !== "expectedCostReceiptId")) throw new Error("Invalid Bot resume acknowledgement.");
  const row = value as BotResumeAcknowledgement;
  if (row.acknowledgeUnknownCost === undefined && row.expectedSubmissionId === undefined && row.expectedCostReceiptId === undefined) return {};
  if (row.acknowledgeUnknownCost !== true || !sourceId(row.expectedSubmissionId) || !receiptId(row.expectedCostReceiptId)) throw new Error("Cost acknowledgement must name the interrupted work and exact unconfirmed cost.");
  return { acknowledgeUnknownCost: true, expectedSubmissionId: row.expectedSubmissionId, expectedCostReceiptId: row.expectedCostReceiptId };
}
