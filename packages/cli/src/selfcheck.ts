/**
 * Self-check entry: bundles like the CLI (same Aiden extension wiring), then
 * reports which Aiden extensions and tools registered in a real pi session.
 * Used by tests/extensions.test.mjs via the dist/selfcheck.mjs build artifact.
 */

import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { createAidenInlineExtensions } from "./extensions/index.ts";

const agentDir = getAgentDir();
const cwd = process.cwd();
const factories = await createAidenInlineExtensions();
const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: factories });
await loader.reload();
const { session } = await createAgentSession({
	cwd,
	agentDir,
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(cwd),
});
const aidenTools = session
	.getAllTools()
	.map((tool) => tool.name)
	.filter((name) =>
		["todo", "ask_user_question", "web_search", "display_image", "recall_memory", "remember_fact", "advisor", "subagent", "render_artifact", "schedule_task"].includes(name),
	)
	.sort();
const extensionNames = loader
	.getExtensions()
	.extensions.map((extension) => (extension as { name?: string }).name ?? String(extension.path).split("/").pop())
	.sort();
process.stdout.write(
	`${JSON.stringify({ extensions: extensionNames, tools: aidenTools, errors: loader.getExtensions().errors.length })}\n`,
);
process.exit(0);
