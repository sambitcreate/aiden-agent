/**
 * Display Image in the terminal: reuses Aiden's desktop extension core
 * (main/services/display-image-extension.ts). The desktop sinks artifacts to
 * its artifact store + renderer; the CLI injects the image content block into
 * the tool result so pi's TUI renders it inline (Kitty/iTerm2 protocols) and
 * keeps a device-local copy under <agentDir>/artifacts.
 */

import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	createDisplayImageExtensionRuntime,
	displayedAssistantImageUsage,
	DISPLAY_IMAGE_TOOL_NAME,
} from "../../../../main/services/display-image-extension.js";
import { aidenExtensionToInlineFactory, type AidenExtensionShape } from "../pi-bridge/adapt-aiden-extension.ts";

type DisplayTool = { execute: (id: string, params: unknown, signal: AbortSignal) => Promise<{ content: unknown[] }> };

/** Images this session already shows, read from its journal like the desktop reads chat history. */
function sessionImageUsage(manager: Pick<ExtensionContext["sessionManager"], "getBranch"> | undefined) {
	const messages: { role: string; attachments: { kind: string; size: number; mimeType: string; data: string }[] }[] = [];
	for (const entry of manager?.getBranch() ?? []) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== DISPLAY_IMAGE_TOOL_NAME) continue;
		const content: unknown = entry.message.content;
		const attachments = (Array.isArray(content) ? content : []).flatMap((part) =>
			part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string"
				? [{ kind: "image", size: Buffer.byteLength(part.data, "base64"), mimeType: part.mimeType, data: part.data }]
				: [],
		);
		messages.push({ role: "assistant", attachments });
	}
	return displayedAssistantImageUsage(messages);
}

export function createDisplayImageInlineExtension(options: {
	agentDir: string;
	workspaceRoot: string;
}): { name: string; factory: ExtensionFactory } {
	const artifactsDir = join(options.agentDir, "artifacts");
	mkdirSync(artifactsDir, { recursive: true });
	let lastPresented: { data: string; mimeType: string } | undefined;
	// The core's counters are per response, like one desktop generation, so
	// each agent run gets a fresh runtime seeded with this session's totals.
	const build = (usage = { bytes: 0, count: 0, pixels: 0 }) => {
		const runtime = createDisplayImageExtensionRuntime({
			workspaceRoot: options.workspaceRoot,
			existingChatImageBytes: usage.bytes,
			existingChatImageCount: usage.count,
			existingChatImagePixels: usage.pixels,
			onArtifact: async (artifact) => {
				lastPresented = { data: artifact.attachment.data, mimeType: artifact.attachment.mimeType };
				try {
					const extension = artifact.attachment.mimeType.split("/")[1]?.split(";")[0] ?? "png";
					await writeFile(
						join(artifactsDir, `display-${Date.now()}.${extension}`),
						Buffer.from(artifact.attachment.data, "base64"),
					);
				} catch {
					// Artifact archiving is best-effort; presentation must not fail.
				}
				return true;
			},
		});
		// A workspace root is always supplied, so the display_image contribution exists.
		const extension = runtime.extension;
		const tool = extension?.tools?.[0] as DisplayTool | undefined;
		if (!extension || !tool) {
			throw new Error("display_image tool missing from the Aiden display-image core");
		}
		return { extension, tool };
	};
	let current = build();
	const wrappedTool = {
		...current.tool,
		async execute(toolCallId: string, params: unknown, signal: AbortSignal) {
			const result = await current.tool.execute(toolCallId, params, signal);
			const presented = lastPresented;
			lastPresented = undefined;
			if (presented) {
				result.content = [...result.content, { type: "image", data: presented.data, mimeType: presented.mimeType }];
			}
			return result;
		},
	};
	const inline = aidenExtensionToInlineFactory("aiden-display-image", {
		id: current.extension.id,
		systemPrompt: current.extension.systemPrompt,
		tools: [wrappedTool],
	} as AidenExtensionShape);
	return {
		name: inline.name,
		factory: (pi) => {
			pi.on("before_agent_start", (_event, ctx) => {
				current = build(sessionImageUsage(ctx?.sessionManager));
			});
			inline.factory(pi);
		},
	};
}
