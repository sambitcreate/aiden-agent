import { VccError } from "./errors.js";
import { estimateTokens, type CompactionPreparation } from "@earendil-works/pi-agent-core";
import type { PiSessionEntry } from "../pi-session-port.js";
import { sanitizeCredentialText } from "../../../renderer/shared/subagent-safe-text.js";
import { compileRanked } from "./vendor/core/summarize.js";
import { compilerMessage, sourceForPreparation } from "./history.js";

export interface VccCompileInput {
  branch: PiSessionEntry[];
  preparation: CompactionPreparation;
  contextWindow: number;
}
export const VCC_REVISION = "1f1575b6e0a07df51e0a9ea8413394ccac3714ae";

export function compileVcc(input: VccCompileInput) {
  const { preparation, contextWindow } = input;
  const source = sourceForPreparation(input.branch, preparation);
  const selected = source.messages.flatMap(({ reference, message }) => {
    const projected = compilerMessage(message);
    return projected ? [{ reference, message: projected }] : [];
  });
  const opaque = source.opaque.map(sanitizeCredentialText).join("\n\n");
  const tailTokens = preparation.retainedTail.reduce(
    (sum, message) => sum + estimateTokens(message),
    0,
  );
  const inputBudget = Math.max(0, contextWindow - preparation.settings.reserveTokens);
  const before =
    estimateTokens({ role: "user", content: preparation.previousSummary ?? "", timestamp: 0 }) +
    [
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
      ...preparation.retainedTail,
    ].reduce((sum, message) => sum + estimateTokens(message), 0);
  for (const briefChars of [8000, 4400, 2200, 1000, 400]) {
    const compiled = compileRanked({
      messages: selected.map((item) => item.message),
      references: selected.map((item) => item.reference),
      fileOps: {
        readFiles: [...preparation.fileOps.read].map(sanitizeCredentialText),
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited].map(
          sanitizeCredentialText,
        ),
      },
      ranking: {
        maxBriefChars: briefChars,
        maxBriefCharsCeiling: briefChars,
        briefCharsPerBlock: 60,
      },
    });
    const summary = [
      opaque ? `[Imported context — preserved verbatim except credentials]\n${opaque}` : "",
      compiled,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!summary.trim()) throw new VccError("empty_summary");
    const estimatedAfter =
      tailTokens + estimateTokens({ role: "user", content: summary, timestamp: 0 }) + 64;
    if (estimatedAfter >= before || estimatedAfter >= inputBudget) continue;
    return {
      summary,
      retainedTail: preparation.retainedTail,
      tokensBefore: preparation.tokensBefore,
      details: {
        engine: "vcc" as const,
        version: 1,
        compiler: "pi-vcc",
        compilerVersion: "0.7.1",
        compilerRevision: VCC_REVISION,
        sourceMessageCount: selected.length,
        sourceLeafId: input.branch[input.branch.length - 1]?.id,
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
      },
    };
  }
  throw new VccError("insufficient_reduction");
}
