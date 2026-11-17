import { createHash, randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { isBoundedBotText } from "../../../renderer/shared/bot-capabilities.js";
import { withoutBotHandoffControls } from "../../../renderer/shared/bot-handoffs.js";
import { localComputerNoun } from "../../../renderer/shared/computer-noun.js";
import {
  BOT_ACCESS_PATH_MAX_BYTES,
  BOT_ACCESS_WHY_MAX_CHARS,
  BOT_REQUEST_ACCESS_TOOL_NAME,
  botAccessChoicesFor,
  botWholeComputerLabel,
  type BotAccessAuthorization,
  type BotAccessResultDetails,
} from "../../../renderer/shared/bot-access-requests.js";
import type { BotIssue } from "../../../renderer/shared/bot-issues.js";
import type { BotFileToolLocation } from "../bot-file-tool-router.js";
import { coveredByBotLocations, type BotAccessResolution } from "./bot-access-target.js";
import { BotAccessRequestStaleError, type BotAccessRequests } from "./bot-access-requests.js";
import { BOT_RUN_ACCESS_MAX_AGE_MS, type BotRunAccess } from "./bot-run-access.js";
import type { BotToolCandidate } from "./bot-tool-assembly.js";
import { botRunUnattended } from "./bot-tool-policy.js";
import type { BotToolCall } from "./tool-adapter.js";

export const BOT_ACCESS_REQUEST_MEMO = "aiden.access-request";
export interface BotAccessRequestToolDeps {
  requests: Pick<BotAccessRequests, "request">;
  runAccess: BotRunAccess;
  resolveTarget(requested: string): Promise<BotAccessResolution>;
  currentLocations(): Promise<readonly BotFileToolLocation[]>;
  /** Exact file locations actually installed with these tools, not a run-start clock. */
  boundLocations: readonly BotFileToolLocation[];
  policyRevision(botId: string): Promise<string>;
  raiseIssue(
    input: Omit<BotIssue, "id" | "createdAt" | "resolvedAt" | "resolution">,
  ): Promise<unknown>;
  resolveIssue?(botId: string, dedupeKey: string, resolution: "fixed"): Promise<unknown>;
  now?(): number;
  folderOffer?(botId: string, path: string): Promise<{ count: number } | undefined>;
}
/** Validate using the current tool task, never the completed Always task's API. */
export async function botSavedLocationForCall(
  botId: string,
  deps: Pick<BotAccessRequestToolDeps, "runAccess" | "policyRevision">,
  call: BotToolCall,
  expectedRevision?: string,
): Promise<BotFileToolLocation | undefined> {
  await call.assertRunActive?.();
  const ids = await call.runRequestIds?.() ?? [];
  if (call.signal.aborted || botRunUnattended(ids)) return undefined;
  const revision = await deps.policyRevision(botId);
  if (expectedRevision !== undefined && expectedRevision !== revision) return undefined;
  return deps.runAccess.savedLocation(botId, ids, revision, {
    signal: call.signal,
    validate: async () => {
      await call.assertRunActive?.();
      const currentIds = await call.runRequestIds?.() ?? [];
      if (botRunUnattended(currentIds) || !ids.some(id => id !== undefined && currentIds.includes(id)) ||
        await deps.policyRevision(botId) !== revision)
        throw new BotAccessRequestStaleError("This task's access changed. Ask again.");
    },
  });
}
function paramsOf(value: unknown): { path: string; why: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Give a folder path and why you need it.");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "path" && key !== "why") ||
    typeof record.path !== "string" ||
    typeof record.why !== "string"
  )
    throw new Error("Give a folder path and why you need it.");
  const why = withoutBotHandoffControls(record.why).trim();
  if (!isBoundedBotText(why, BOT_ACCESS_WHY_MAX_CHARS) || !why)
    throw new Error("Give a short reason, up to 400 characters.");
  if (
    !isBoundedBotText(record.path, BOT_ACCESS_PATH_MAX_BYTES) ||
    Buffer.byteLength(record.path) > BOT_ACCESS_PATH_MAX_BYTES ||
    record.path.includes("\0")
  )
    throw new Error("Keep the folder path under 4,096 bytes.");
  return { path: record.path, why };
}
const REFUSED = {
  filesystem_root: `Ask for "whole_mac" to use the whole ${localComputerNoun(process.platform)}.`,
  private: "That folder belongs to Aiden and can't be shared with a Bot.",
  not_found: "That folder doesn't exist.",
  not_absolute: "Give the folder's full path, like ~/Documents/Taxes.",
  too_long: "Keep the folder path under 4,096 bytes.",
} as const;
export function botAccessRequestCandidate(
  botId: string,
  deps: BotAccessRequestToolDeps,
): BotToolCandidate {
  const schema: AgentTool = {
    name: BOT_REQUEST_ACCESS_TOOL_NAME,
    label: "Request access",
    description:
      'Ask the person to read and change a folder outside your current access. Use an absolute path, ~/Documents/Taxes, or "whole_mac". The person can allow this task once, always allow an eligible folder, or say Not now. On unattended turns this leaves a Needs you issue; carry on without that access. After approval, use file tools with location "run.access". Only one extra folder is available per task; another approval replaces it. Never request Aiden private storage.',
    executionMode: "sequential",
    parameters: Type.Object(
      {
        path: Type.String({ minLength: 1, maxLength: BOT_ACCESS_PATH_MAX_BYTES }),
        why: Type.String({ minLength: 1, maxLength: BOT_ACCESS_WHY_MAX_CHARS }),
      },
      { additionalProperties: false },
    ),
    async execute() {
      throw new Error("An access request needs the Bot's live task.");
    },
  };
  return {
    tool: schema,
    replay: "safe",
    interactive: true,
    bind: (call) => ({
      ...schema,
      async execute(_toolCallId, value): Promise<AgentToolResult<BotAccessResultDetails | null>> {
        const params = paramsOf(value);
        await call.assertRunActive?.();
        if (call.signal.aborted) throw call.signal.reason;
        const target = await deps.resolveTarget(params.path);
        if (target.kind === "refused")
          return {
            content: [{ type: "text", text: REFUSED[target.reason] }],
            details: null,
            isError: true,
          };
        const revision = await deps.policyRevision(botId);
        const fixed = await deps.currentLocations();
        if ((await deps.policyRevision(botId)) !== revision)
          throw new Error("This Bot's access changed. Ask for access again.");
        const ids = (await call.runRequestIds?.()) ?? [];
        const requestIds = ids.filter((id): id is string => id !== undefined);
        if (!ids.length || !requestIds.length)
          throw new Error("The owning Bot task is unavailable. Ask again in a new task.");
        await call.assertRunActive?.();
        const key = target.kind === "whole_mac" ? "whole_mac" : target.root;
        const issueKey = `access:${key}`;
        const dedupeKey = Array.from(issueKey).length <= 400 ? issueKey : `access:${createHash("sha256").update(key).digest("hex")}`;
        const root = target.kind === "whole_mac" ? "/" : target.root;
        const label = target.kind === "whole_mac" ? botWholeComputerLabel(process.platform) : target.label;
        const result = (
          outcome: BotAccessResultDetails["outcome"],
          text: string,
        ): AgentToolResult<BotAccessResultDetails> => ({
          content: [{ type: "text", text }],
          details: { target: target.kind, label, outcome },
        });
        const run = deps.runAccess.location(botId, ids, revision);
        if (coveredByBotLocations(root, [...fixed, ...(run ? [run] : [])], "write")) {
          await deps.resolveIssue?.(botId, dedupeKey, "fixed");
          if (coveredByBotLocations(root, run ? [run] : [], "write"))
            return result("already_allowed", `You can already read and change ${label}. Use file tools with location "run.access" to reach it.`);
          const bound = deps.boundLocations.find(location =>
            coveredByBotLocations(root, [location], "write") && fixed.some(current =>
              current.id === location.id && current.root === location.root &&
              JSON.stringify(current.expectedIdentity) === JSON.stringify(location.expectedIdentity) &&
              coveredByBotLocations(root, [current], "write")));
          if (bound)
            return result("already_allowed", `You can already read and change ${label}. Use file tools with location ${JSON.stringify(bound.id)} to reach it.`);
          // Only this task's own attended Always publication can supply the
          // second alias. Fresh Settings/issue approvals are future authority.
          const saved = await botSavedLocationForCall(botId, deps, call, revision);
          if (saved && coveredByBotLocations(root, [saved], "write"))
            return result("already_allowed", `You can already read and change ${label}. Use file tools with location "run.saved" to reach it. Your separate "run.access" folder is unchanged.`);
          return result("already_allowed", `${label} is approved for future tasks. This task's bound file tools cannot reach that new fixed location. Start a new task to use it.`);
        }
        if (deps.runAccess.declined(botId, ids, key))
          return result(
            "declined_earlier",
            "The person already said not now to this in this task. Carry on without it.",
          );
        const choices = botAccessChoicesFor({
          target: target.kind,
          alwaysOffered: target.kind === "folder" && target.always.kind !== "none",
        });
        const grant =
          target.kind === "folder" && target.always.kind !== "none"
            ? {
                folderPath: target.root,
                ...(target.always.kind === "existing" ? { rootId: target.always.rootId } : {}),
              }
            : undefined;
        const authorization: BotAccessAuthorization = {
          policyRevision: revision,
          requestIds: [...new Set(requestIds)],
          target: target.kind,
          root,
          choices,
          ...(target.kind === "folder"
            ? {
                identity: { device: target.device, inode: target.inode },
                ...(target.inventoryRevision
                  ? { inventoryRevision: target.inventoryRevision }
                  : {}),
              }
            : {}),
          ...(grant?.rootId ? { rootId: grant.rootId } : {}),
        };
        if (botRunUnattended(ids)) {
          // Paths may be 4,096 bytes; issue dedupe keys are bounded to 400
          // characters. Preserve readable short keys and hash longer roots.
          await deps.raiseIssue({
            botId,
            kind: "access_needed",
            dedupeKey,
            title: `Wants to use ${label}`,
            body: Array.from(params.why).slice(0, 280).join(""),
            actions: grant
              ? [{ kind: "dismiss_access" }, { kind: "allow_folder" }]
              : [{ kind: "dismiss_access" }, { kind: "open_settings", section: "access" }],
            access: { label, ...(grant ?? {}), authorization },
          });
          return result(
            "asked_later",
            "Nobody can answer a card on this turn, so the person will see this request in your chat. Carry on without it and say what is waiting on it.",
          );
        }
        const memo = await call.memo(BOT_ACCESS_REQUEST_MEMO, { requestId: randomUUID() });
        const offer = grant ? await deps.folderOffer?.(botId, root) : undefined;
        const owner = {
          signal: call.signal,
          deadline: (deps.now?.() ?? Date.now()) + BOT_RUN_ACCESS_MAX_AGE_MS,
          validate: async () => {
            await call.assertRunActive?.();
            const currentIds = (await call.runRequestIds?.()) ?? [];
            if (
              !currentIds.length ||
              botRunUnattended(currentIds) ||
              !authorization.requestIds.some((id) => currentIds.includes(id))
            )
              throw new BotAccessRequestStaleError("This access request is no longer part of an attended task.");
            if (call.signal.aborted) throw call.signal.reason;
          },
        };
        await owner.validate();
        let answer;
        try { answer = await deps.requests.request({
          botId,
          logicalRequestId: memo.requestId,
          toolCallId: call.callId,
          target: target.kind,
          label,
          ...(target.kind === "folder" ? { place: target.place } : {}),
          why: params.why,
          choices,
          ...(offer ? { approvalCount: offer.count } : {}),
          authorization,
          ...(grant ? { grant } : {}),
          owner,
          signal: call.signal,
        }); } catch (error) {
          if (!(error instanceof BotAccessRequestStaleError)) throw error;
          return result("access_changed", "Access changed while this request was waiting. Ask for access again if it is still needed.");
        }
        if (answer.choice === "not_now") {
          deps.runAccess.decline(botId, requestIds, key);
          return result(
            "not_now",
            `The person said not now. Carry on without ${label} and tell them what you couldn't do.`,
          );
        }
        // Authorization and the run grant have already committed at the answer
        // boundary. Never issue a second grant or adopt another policy revision.
        const allowed = result(
          answer.choice,
          answer.savedForFuture ? `The person approved ${label} for future tasks. This acknowledgement records that earlier approval and does not grant temporary access or restore removed access. Check current access on a new task.` : `The person allowed ${label} for this task. Use the file tools with location "run.access" to reach it.${answer.choice === "always" ? " It stays allowed from your next task." : ""}`,
        );
        return answer.hint ? { ...allowed, content: [...allowed.content, { type: "text", text: "\n\n" + answer.hint }] } : allowed;
      },
    }),
  };
}
