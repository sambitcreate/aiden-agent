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
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createDisplayImageExtensionRuntime } from "../../../../main/services/display-image-extension.js";
import { aidenExtensionToInlineFactory, type AidenExtensionShape } from "../pi-bridge/adapt-aiden-extension.ts";

export function createDisplayImageInlineExtension(options: {
	agentDir: string;
	workspaceRoot: string;
}): { name: string; factory: ExtensionFactory } {
	const artifactsDir = join(options.agentDir, "artifacts");
	mkdirSync(artifactsDir, { recursive: true });
	let lastPresented: { data: string; mimeType: string } | undefined;
	const runtime = createDisplayImageExtensionRuntime({
		workspaceRoot: options.workspaceRoot,
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
	const original = runtime.extension.tools?.[0] as
		| { execute: (id: string, params: unknown, signal: AbortSignal) => Promise<{ content: unknown[] }> }
		| undefined;
	if (!original) {
		throw new Error("display_image tool missing from the Aiden display-image core");
	}
	const wrappedTool = {
		...original,
		async execute(toolCallId: string, params: unknown, signal: AbortSignal) {
			const result = await original.execute(toolCallId, params, signal);
			const presented = lastPresented;
			lastPresented = undefined;
			if (presented) {
				result.content = [...result.content, { type: "image", data: presented.data, mimeType: presented.mimeType }];
			}
			return result;
		},
	};
	return aidenExtensionToInlineFactory("aiden-display-image", {
		id: runtime.extension.id,
		systemPrompt: runtime.extension.systemPrompt,
		tools: [wrappedTool],
	} as AidenExtensionShape);
}
