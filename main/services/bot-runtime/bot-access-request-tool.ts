import { createHash, randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { isBoundedBotText } from "../../../renderer/shared/bot-capabilities.js";
import { withoutBotHandoffControls } from "../../../renderer/shared/bot-handoffs.js";
import {
  BOT_ACCESS_PATH_MAX_BYTES,
  BOT_ACCESS_WHY_MAX_CHARS,
  BOT_REQUEST_ACCESS_TOOL_NAME,
  botAccessChoicesFor,
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

export const BOT_ACCESS_REQUEST_MEMO = "aiden.access-request";
export interface BotAccessRequestToolDeps {
  requests: Pick<BotAccessRequests, "request">;
  runAccess: BotRunAccess;
  resolveTarget(requested: string): Promise<BotAccessResolution>;
  currentLocations(): Promise<readonly BotFileToolLocation[]>;
  policyRevision(botId: string): Promise<string>;
  raiseIssue(
    input: Omit<BotIssue, "id" | "createdAt" | "resolvedAt" | "resolution">,
  ): Promise<unknown>;
  resolveIssue?(botId: string, dedupeKey: string, resolution: "fixed"): Promise<unknown>;
  now?(): number;
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
  filesystem_root: 'Ask for "whole_mac" to use the whole Mac.',
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
        const label = target.kind === "whole_mac" ? "your whole Mac" : target.label;
        const result = (
          outcome: BotAccessResultDetails["outcome"],
          text: string,
        ): AgentToolResult<BotAccessResultDetails> => ({
          content: [{ type: "text", text }],
          details: { target: target.kind, label, outcome },
        });
        const run = deps.runAccess.location(botId, ids, revision);
        if (coveredByBotLocations(root, [...fixed, ...(run ? [run] : [])], "write")) {
          // Bound file-tool schemas may predate a new fixed folder. Refresh
          // their late location from authority the person already granted.
          if (!coveredByBotLocations(root, run ? [run] : [], "write")) {
            await call.assertRunActive?.();
            if (call.signal.aborted) throw call.signal.reason;
            if (await deps.policyRevision(botId) !== revision) throw new BotAccessRequestStaleError("This Bot's access changed. Ask again.");
            const now = deps.now?.() ?? Date.now();
            deps.runAccess.grant(botId, { requestIds, target: target.kind, key, root, label,
              ...(target.kind === "folder" ? { identity: { device: target.device, inode: target.inode } } : {}),
              policyRevision: revision, access: "write", owner: { kind: "access", id: randomUUID() },
              grantedAt: now, expiresAt: now + BOT_RUN_ACCESS_MAX_AGE_MS });
          }
          await deps.resolveIssue?.(botId, dedupeKey, "fixed");
          return result("already_allowed", `You can already read and change ${label}. Use file tools with location "run.access" to reach it.`);
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
          authorization,
          ...(grant ? { grant } : {}),
          owner,
          signal: call.signal,
        }); } catch (error) {
          if (!(error instanceof BotAccessRequestStaleError)) throw error;
          return result("access_changed", "Access changed while this request was waiting. Nothing was allowed or declined. Ask for access again if it is still needed.");
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
        return result(
          answer.choice,
          answer.savedForFuture ? `The person saved ${label} for future tasks. This task no longer owns an active access request; no temporary access was granted.` : `The person allowed ${label} for this task. Use the file tools with location "run.access" to reach it.${answer.choice === "always" ? " It stays allowed from your next task." : ""}`,
        );
      },
    }),
  };
}
