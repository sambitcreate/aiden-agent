import {
  InMemorySessionRepo,
  estimateTokens,
  prepareCompaction,
} from "@earendil-works/pi-agent-core";
import { createPiSessionPort } from "../pi-session-port.js";
import { compileVccInWorker } from "./worker-client.js";
import { recallVcc } from "./recall-core.js";

/** Synthetic annotated cases: no user's conversations or provider calls. */
export async function runVccReplayCases() {
  const cases = [
    {
      id: "coding",
      facts: [
        ["goal", "Repair the authentication refresh flow"],
        ["constraint", "Always retain database schema v2"],
        ["decision", "Use refresh tokens with rotation"],
        ["unresolved", "Pending: regression suite still fails"],
        ["completed", "Completed: migration tests passed"],
      ],
    },
    {
      id: "planning-multilingual",
      facts: [
        ["goal", "Plan a community workshop"],
        ["constraint", "Prefer vegetarian food for attendees"],
        ["decision", "Use the library meeting room"],
        ["unresolved", "待办：确认星期六的时间"],
        ["completed", "Completed: invitations drafted"],
      ],
    },
  ];
  const measurements = [];
  for (const scenario of cases) {
    const session = createPiSessionPort(
      await new InMemorySessionRepo().create({ id: scenario.id }),
    );
    for (const [index, [, fact]] of scenario.facts.entries()) {
      await session.appendMessage({ role: "user", content: fact, timestamp: index });
      await session.appendMessage({
        role: "user",
        content: "Background discussion. ".repeat(900),
        timestamp: index + 20,
      });
    }
    await session.appendMessage({
      role: "user",
      content: "Continue with the remaining work",
      timestamp: 100,
    });
    const branch = await session.getBranch();
    const preparation = prepareCompaction(branch, {
      enabled: true,
      reserveTokens: 1000,
      keepRecentTokens: 200,
    });
    if (!preparation.ok || !preparation.value) throw new Error("Replay preparation failed.");
    const before = (await session.buildContext()).messages.reduce(
      (n, m) => n + estimateTokens(m),
      0,
    );
    const start = performance.now();
    const result = await compileVccInWorker({
      branch,
      preparation: preparation.value,
      contextWindow: 32000,
    });
    const durationMs = performance.now() - start;
    await session.appendCompaction({ id: `checkpoint-${scenario.id}`, ...result });
    const afterBranch = await session.getBranch();
    const facts = scenario.facts.map(([category, fact]) => ({
      category,
      inSummary: result.summary.includes(fact),
      recalled: recallVcc({ kind: "recall", branch: afterBranch, query: fact }).includes(fact),
    }));
    measurements.push({
      caseId: scenario.id,
      facts,
      tokensBefore: before,
      estimatedTokensAfter: (await session.buildContext()).messages.reduce(
        (n, m) => n + estimateTokens(m),
        0,
      ),
      durationMs: Math.round(durationMs),
      summarizationCalls: 0,
      processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    });
  }
  return { version: 1, engine: "vcc", corpus: "synthetic-annotated-v1", measurements };
}
