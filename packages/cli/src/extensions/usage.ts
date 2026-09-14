/**
 * /usage — token and cost summary for the current session, computed from the
 * session journal the same way pi's RPC get_session_stats reports them.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { recordUsage, usageSummary } from "../usage-ledger.ts";

function numeric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function createUsageInlineExtension(agentDir: string): { name: string; factory: ExtensionFactory } {
	return {
		name: "aiden-usage",
		factory: (pi) => {
			pi.on("message_end", async (event) => { if (event.message.role === "assistant") await recordUsage(agentDir, "chat", event.message); });
			pi.registerCommand("usage", {
				description: "Show token usage and cost for this session",
				handler: async (_args, ctx) => {
					if (_args.trim() === "all") { ctx.ui.notify(JSON.stringify(await usageSummary(agentDir), null, 2), "info"); return; }
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let cost = 0;
					let assistantMessages = 0;
					try {
						for (const entry of ctx.sessionManager.getEntries()) {
							const message = (entry as { message?: { role?: string; usage?: Record<string, unknown> } }).message;
							if (message?.role !== "assistant") continue;
							assistantMessages += 1;
							const usage = message.usage ?? {};
							input += numeric(usage.input);
							output += numeric(usage.output);
							cacheRead += numeric(usage.cacheRead);
							cacheWrite += numeric(usage.cacheWrite);
							const usageCost = usage.cost as { total?: unknown } | undefined;
							cost += numeric(usageCost?.total);
						}
					} catch (error) {
						ctx.ui.notify(`Could not read session entries: ${error instanceof Error ? error.message : String(error)}`, "error");
						return;
					}
					const total = input + output + cacheRead + cacheWrite;
					const lines = [
						`Session usage — ${assistantMessages} assistant ${assistantMessages === 1 ? "message" : "messages"}`,
						`  input       ${input.toLocaleString()} tokens`,
						`  output      ${output.toLocaleString()} tokens`,
						`  cache read  ${cacheRead.toLocaleString()} tokens`,
						`  cache write ${cacheWrite.toLocaleString()} tokens`,
						`  total       ${total.toLocaleString()} tokens`,
					];
					if (cost > 0) {
						lines.push(`  cost        $${cost.toFixed(4)}`);
					}
					ctx.ui.notify(lines.join("\n"), "info");
				},
			});
		},
	};
}
