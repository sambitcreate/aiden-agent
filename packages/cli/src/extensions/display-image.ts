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

type ImageUsage = { bytes: number; count: number; pixels: number };

/**
 * One presented image's usage, recorded beside the journal. A display_image run through codemode or
 * `ctx.executeTool()` leaves no display_image result of its own: pi journals only the outer tool's.
 */
const DISPLAY_IMAGE_USAGE_ENTRY = "aiden-display-image-usage";

function imageUsage(image: { data: string; mimeType: string }): ImageUsage {
	return displayedAssistantImageUsage([
		{ role: "assistant", attachments: [{ kind: "image", size: Buffer.byteLength(image.data, "base64"), ...image }] },
	]);
}

const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

/** Images this session already shows, read from its journal like the desktop reads chat history. */
function sessionImageUsage(manager: Pick<ExtensionContext["sessionManager"], "getBranch"> | undefined): ImageUsage {
	const messages: { role: string; attachments: { kind: string; size: number; mimeType: string; data: string }[] }[] = [];
	const counted = new Set<string>();
	const recorded: { toolCallId: string; usage: ImageUsage }[] = [];
	for (const entry of manager?.getBranch() ?? []) {
		if (entry.type === "custom" && entry.customType === DISPLAY_IMAGE_USAGE_ENTRY) {
			const data = entry.data as { toolCallId?: unknown; bytes?: unknown; count?: unknown; pixels?: unknown } | undefined;
			if (typeof data?.toolCallId === "string") {
				recorded.push({ toolCallId: data.toolCallId, usage: { bytes: count(data.bytes), count: count(data.count), pixels: count(data.pixels) } });
			}
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== DISPLAY_IMAGE_TOOL_NAME) continue;
		counted.add(entry.message.toolCallId);
		const content: unknown = entry.message.content;
		const attachments = (Array.isArray(content) ? content : []).flatMap((part) =>
			part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string"
				? [{ kind: "image", size: Buffer.byteLength(part.data, "base64"), mimeType: part.mimeType, data: part.data }]
				: [],
		);
		messages.push({ role: "assistant", attachments });
	}
	const usage = displayedAssistantImageUsage(messages);
	// Journals from before the record, and top-level calls, count once from their own result.
	for (const { toolCallId, usage: extra } of recorded) {
		if (counted.has(toolCallId)) continue;
		usage.bytes = Math.min(Number.MAX_SAFE_INTEGER, usage.bytes + extra.bytes);
		usage.count += extra.count;
		usage.pixels = Math.min(Number.MAX_SAFE_INTEGER, usage.pixels + extra.pixels);
	}
	return usage;
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
	let recordUsage: ((customType: string, data: unknown) => void) | undefined;
	const wrappedTool = {
		...current.tool,
		async execute(toolCallId: string, params: unknown, signal: AbortSignal) {
			const result = await current.tool.execute(toolCallId, params, signal);
			const presented = lastPresented;
			lastPresented = undefined;
			if (presented) {
				result.content = [...result.content, { type: "image", data: presented.data, mimeType: presented.mimeType }];
				recordUsage?.(DISPLAY_IMAGE_USAGE_ENTRY, { toolCallId, ...imageUsage(presented) });
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
			recordUsage = (customType, data) => pi.appendEntry(customType, data);
			pi.on("before_agent_start", (_event, ctx) => {
				current = build(sessionImageUsage(ctx?.sessionManager));
			});
			inline.factory(pi);
		},
	};
}
