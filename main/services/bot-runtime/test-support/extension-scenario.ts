// Child-process half of the extension crash tests (run through
// kill-harness.mjs `scenario`). It starts a Bot turn that reaches a tool call
// or an approval prompt and announces it, so the parent can SIGKILL it there.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createBotRegistry } from "../bot-extension.js";
import { createBotHarnessHost } from "../harness-host.js";
import { blockingUntilAborted, countingTool, recordingDeps } from "./fixtures.js";
import { createFauxModels, FAUX_MODEL_REF } from "./faux.js";

type Emit = (tag: string, value: unknown) => void;

export interface ScenarioArgs {
  profileDir: string;
  botId: string;
  /** `handoff-answered`: the person answers Done at once, and the child dies while the answer is recorded. */
  /** `script-approval`: a codemode script's call waits for approval. */
  rule?: "first" | "edited";
  kind: "approval" | "script-approval" | "tools" | "handoff" | "handoff-answered" | "approval-receipt" | "approval-binding" | "approval-publication";
}

/** The rule hand-off every `handoff` scenario call gets. */
export const SCENARIO_RULE_HANDOFF = {
  rule: { id: "default.purchase", label: "Make a purchase or booking" },
  summary: "Click Place your order — Safari",
  action: "Make a purchase or booking",
  why: "Your rule “Make a purchase or booking” hands this to you.",
} as const;

/** The connection tool the `script-approval` script calls, and the script. */
export const SCENARIO_SCRIPT_TOOL = "docs__gated";
export const SCENARIO_SCRIPT = `text(await tools.${SCENARIO_SCRIPT_TOOL}({ text: "x" }))`;

export async function run(args: ScenarioArgs, emit: Emit): Promise<void> {
  const ctx = BACKGROUND_CONTEXT;
  const hang = (name: string) =>
    countingTool(name, async (_params, signal) => {
      emit("TOOL_RUNNING", name);
      return blockingUntilAborted(signal);
    });
  const replay = args.kind === "approval-receipt" || args.kind === "approval-binding" || args.kind === "approval-publication" ? await approvalReplayDeps(args, { emit, rule: args.rule, always: args.kind === "approval-publication" }) : undefined;
  const deps = replay?.deps ?? (
    args.kind === "handoff" || args.kind === "handoff-answered"
      ? recordingDeps({
          tools: [{ tool: countingTool("gated"), replay: "unsafe" }],
          policy: () => ({ allowed: true, handoff: { ...SCENARIO_RULE_HANDOFF, rule: { ...SCENARIO_RULE_HANDOFF.rule } } }),
          handoff: async (request) => {
            emit("HANDOFF", request.waitId);
            if (args.kind === "handoff-answered") return { outcome: "done", note: "Booked for two" };
            return blockingUntilAborted(request.signal);
          },
        })
      : args.kind === "approval" || args.kind === "script-approval"
      ? recordingDeps({
          tools: [
            args.kind === "approval"
              ? { tool: countingTool("gated"), replay: "unsafe" }
              : { tool: countingTool(SCENARIO_SCRIPT_TOOL), replay: "unsafe", mcp: true },
          ],
          policy: () => ({ allowed: true, approval: { summary: "Run gated" } }),
          approve: async (request) => {
            emit("APPROVAL", request.waitId);
            return blockingUntilAborted(request.signal);
          },
        })
      : recordingDeps({
          tools: [
            { tool: hang("unsafe_op"), replay: "unsafe" },
            { tool: hang("safe_op"), replay: "safe" },
          ],
        })
  );
  if (args.kind === "handoff-answered") {
    deps.recordHandoff = async (record) => {
      emit("RECORDING", record.toolCallId);
      await new Promise<never>(() => undefined);
    };
  }
  const firstResponse =
    replay
      ? fauxAssistantMessage([fauxToolCall(replay.tool.name, { text: "Save" }, { id: "duplicate-provider-call" })], { stopReason: "toolUse" })
      : args.kind === "script-approval"
      ? fauxAssistantMessage([fauxToolCall("codemode", { code: SCENARIO_SCRIPT }, { id: "script-1" })], { stopReason: "toolUse" })
      : args.kind !== "tools"
      ? fauxAssistantMessage([fauxToolCall("gated", { text: "x" })], { stopReason: "toolUse" })
      : fauxAssistantMessage(
          [fauxToolCall("unsafe_op", { text: "u" }), fauxToolCall("safe_op", { text: "s" })],
          { stopReason: "toolUse" },
        );
  const { models } = createFauxModels([firstResponse]);
  const registries = new Map<string, ReturnType<typeof createBotRegistry>>();
  const host = await createBotHarnessHost({
    profileDir: args.profileDir,
    models,
    buildRegistry: (botId) => {
      const registry = createBotRegistry(botId, deps);
      registries.set(botId, registry);
      return registry;
    },
  });
  if ("unavailable" in host) throw new Error("profile locked");
  const { conversation } = await host.open(args.botId);
  await registries.get(args.botId)!.refresh();
  await conversation.configure({ model: FAUX_MODEL_REF }, ctx);
  const submission = await conversation.submit({ type: "input", content: "go", requestId: "scenario" }, ctx);
  emit("SUBMITTED", String(submission.id));
}


/** Real policy, persistent consent receipts and persistent D decisions around
 * the two crash gaps. This is a host test adapter, not the Task 5 service. */
export async function approvalReplayDeps(args: Pick<ScenarioArgs, "profileDir" | "botId" | "kind">, options: {
  emit?: Emit;
  page?: string;
  rule?: "first" | "edited";
  always?: boolean;
  bindingError?: boolean;
} = {}) {
  const { randomUUID } = await import("node:crypto");
  const { DataStore } = await import("../../data-store.js");
  const { ToolApprovalRuleBook, emptyToolApprovalRulesDocument, normalizeToolApprovalRulesDocument, TOOL_APPROVAL_RULES_MAX_BYTES } = await import("../../tool-approval-rules.js");
  const { createBotApprovalTallies } = await import("../bot-approval-tallies.js");
  const { createBotApprovals } = await import("../bot-approvals.js");
  const { assemblyDeps, assemblyState, testAuthority, FULL_GRANTS } = await import("./assembly-fixtures.js");
  const { join } = await import("node:path");
  const base = Date.parse("2026-11-04T12:00:00Z");
  const now = () => base + (options.page ? 1_000 : 0);
  const target = { kind: "site", host: "docs.example", action: "click" } as const;
  const tallies = createBotApprovalTallies({ profileDir: () => args.profileDir, now });
  for (let index = 0; index < 3; index++) await tallies.record(args.botId, target, {
    id: `seed-${index}`, authorizationFingerprint: `seed-fp-${index}`, answer: "allow", source: "person", offered: false, decidedAt: base - (3 - index) * 1_000,
  });
  const book = new ToolApprovalRuleBook(new DataStore("task4-consent.json", emptyToolApprovalRulesDocument(), () => args.profileDir,
    { normalize: normalizeToolApprovalRulesDocument, reloadBeforeWrite: true, maxBytes: TOOL_APPROVAL_RULES_MAX_BYTES, fileMode: 0o600 }),
    () => new Date(now()), randomUUID, { knownBot: async () => true });
  const tool = countingTool("browser_click");
  await (await import("node:fs/promises")).mkdir(join(args.profileDir, "home"), { recursive: true });
  const state = assemblyState(testAuthority({ mode: "full", home: join(args.profileDir, "home"), ...FULL_GRANTS, other: [...FULL_GRANTS.other, "browser"] }));
  let lastDecision: import("../bot-extension.js").BotApprovalDecision | undefined;
  const settlements: Parameters<NonNullable<import("../bot-extension.js").BotExtensionDeps["settleApproval"]>>[0][] = [];
  const bridge = createBotApprovals({ lookupDecision: (...input) => tallies.decision(...input), publish(prompt) {
    queueMicrotask(() => bridge.decide(prompt.waitId, "allow", options.always ? "always" : undefined));
  } });
  const deps = assemblyDeps(state, {
    candidates: () => [{ tool, replay: "unsafe" }],
    allowList: { consentRevision: (...input) => book.botConsentRevision(...input), match: (...input) => book.matchBot(...input),
      used: (...input) => book.recordBotUse(...input), offer: (...input) => tallies.nudge(...input) },
    rules: () => options.rule ? [{ id: "custom.save", text: options.rule === "first" ? "save" : "save documents", behavior: "ask", locked: false }] : [],
    approvalFor: async () => ({ approval: { summary: "Save", onAllow: async () => {
      if (options.emit && args.kind === "approval-binding") { options.emit("BINDING", JSON.stringify(lastDecision)); await new Promise<never>(() => undefined); }
      if (options.bindingError) throw new Error("The page changed.");
    } }, action: { surface: "browser", tool: "browser_click", url: "https://docs.example/edit", field: { accessibleName: "Save documents" } },
      browserTarget: { workspaceId: "b", tabId: "t", url: "https://docs.example/edit", documentRevision: options.page ?? "page-1", controlRevision: 0 } }),
  });
  deps.requestApproval = async request => { deps.approvals.push(request); return lastDecision = await bridge.request(request); };
  deps.settleApproval = async input => {
    settlements.push(structuredClone(input));
    const result = await tallies.record(input.botId, input.remember.target, { ...input.decision, offered: !!input.remember.offer });
    if (options.emit && args.kind === "approval-receipt") { options.emit("RECEIPT", JSON.stringify(input.decision)); await new Promise<never>(() => undefined); }
    if (input.decision.source === "person" && input.decision.answer === "allow_always") {
      const published = await book.grantBot(input.botId, input.remember.target, input.remember.title, input.decision.id);
      await tallies.completePublication(input.botId, input.decision.id, input.decision.authorizationFingerprint, published.status);
      const entry = await book.matchBot(input.botId, input.remember.target);
      if (options.emit && args.kind === "approval-publication") { options.emit("PUBLICATION", JSON.stringify(input.decision)); await new Promise<never>(() => undefined); }
      return published.status === "published" && entry ? { publication: { target: input.remember.target, ruleId: entry.id,
        consentRevision: await book.botConsentRevision(input.botId, input.remember.target) } } : {};
    }
    return result.hintCount ? { hint: `Aiden note: approval ${result.hintCount}` } : {};
  };
  return { deps, tool, state, tallies, book, target, settlements };
}
