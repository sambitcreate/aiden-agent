/**
 * Durable memory in the terminal: reuses Aiden's SQLite memory core
 * (main/services/memory-store.ts + memory-context.ts). The store lives in the
 * shared `~/.aiden/memory` root the desktop also uses, scoped to the
 * workspace's canonical folder hash — facts remembered here are recalled by
 * the desktop and vice versa. The legacy per-CLI store under
 * <agentDir>/memory is absorbed on first open. remember facts are
 * owner-approved by nature of the explicit tool call (provenance
 * "user_edit", source "aiden-cli").
 *
 * Desktop parity note: the desktop injects the always-on memory prompt per
 * generation, gated by the memory settings. The CLI mirrors that by
 * re-checking the setting and re-reading facts at every turn boundary
 * (before_agent_start) instead of freezing a startup snapshot. Unattended
 * daemon chats (scheduled tasks, Telegram) run read-only — matching the
 * desktop rule that unattended generations get recall but no durable writes.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../../../../main/services/memory-store.js";
import {
	createMemoryExtension,
	formatAlwaysOnMemory,
} from "../../../../main/services/memory-context.js";
import { aidenExtensionToInlineFactory, type AidenExtensionShape } from "../pi-bridge/adapt-aiden-extension.ts";
import { sharedMemoryRoot } from "../../../../main/services/memory-shared.js";
import { legacyWorkspaceScopeIdMap, memoryEnabledFor, workspaceScopeId } from "./memory-scope.ts";

export async function createMemoryInlineExtension(options: {
	agentDir: string;
	workspaceRoot: string;
	/** Recall-only: no remember/forget tools (unattended generations). */
	readOnly?: boolean;
}): Promise<{ name: string; factory: ExtensionFactory }> {
	// Memory disabled → never open the store (no migration writes either).
	if (!memoryEnabledFor(options.agentDir, options.workspaceRoot)) {
		return { name: "aiden-memory", factory: () => undefined };
	}
	const root = sharedMemoryRoot(options.agentDir);
	mkdirSync(root, { recursive: true });
	const store = new MemoryStore({
		root: () => root,
		imports: async () => [{
			file: join(options.agentDir, "memory", "memory-v1.sqlite"),
			scopeIds: legacyWorkspaceScopeIdMap(options.agentDir, options.workspaceRoot),
		}],
	});
	const scope = { kind: "workspace" as const, id: workspaceScopeId(options.workspaceRoot) };
	// A settings read failure must fail closed — never let it bubble a
	// handler rejection into the turn.
	const enabled = async (): Promise<boolean> => {
		try { return memoryEnabledFor(options.agentDir, options.workspaceRoot); }
		catch { return false; }
	};
	const extension = await createMemoryExtension({
		store,
		scope,
		provenance: options.readOnly ? undefined : { kind: "user_edit", sourceId: "aiden-cli" },
		enabled,
	});
	// The desktop's createMemoryExtension freezes the always-on prompt at
	// construction; strip it here and inject it per turn instead.
	const { factory } = aidenExtensionToInlineFactory("aiden-memory", {
		id: extension.id,
		tools: extension.tools,
	} as AidenExtensionShape);
	const wrapped: ExtensionFactory = (pi) => {
		factory(pi);
		// Daemon chats build a fresh store per generation — release the handle
		// when the session ends instead of leaking it until GC.
		pi.on("session_shutdown", () => { void store.close(); });
		pi.on("before_agent_start", async (event) => {
			if (!(await enabled())) return;
			try {
				const prompt = formatAlwaysOnMemory(scope, await store.alwaysOn(scope));
				if (prompt.trim()) {
					return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
				}
			} catch {
				// A memory read failure must never break the turn.
			}
			return undefined;
		});
	};
	return { name: "aiden-memory", factory: wrapped };
}
