import { Type } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { generativeUiExportDocument, requireGenerativeUiTitle } from "../../../../main/services/generative-ui-html.js";
import { MAX_HTML_ARTIFACTS_PER_CHAT, MAX_HTML_ARTIFACT_BYTES_PER_CHAT } from "../../../../renderer/shared/generative-ui.js";
import { JsonStore } from "../state.ts";

export function createArtifactsExtension(agentDir: string): InlineExtension {
  const inventory = new JsonStore<Array<{ sessionId: string; path: string; bytes: number }>>(join(agentDir, "artifacts.json"), []);
  return { name: "aiden-artifacts", factory(pi) {
    let count = 0;
    pi.on("before_agent_start", async () => { count = 0; });
    pi.registerTool({ name: "render_artifact", label: "HTML artifact", description: "Create a standalone, sandboxed HTML visualization with offline Chart.js, Plotly, and KaTeX. Returns a local HTML file path.",
      parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 120 }), html: Type.String({ minLength: 1, maxLength: 524288 }) }),
      async execute(_id, input, _signal, _onUpdate, ctx) {
        if (count >= 4) throw new Error("At most four artifacts may be created per response.");
        const title = requireGenerativeUiTitle(input.title);
        const root = dirname(process.env.AIDEN_CLI_ENTRY!);
        const files = { "chart.js": "chart.umd.min.js", "plotly.js": "plotly.min.js", "katex.js": "katex.min.js", "katex.css": "katex.min.css" };
        const libraries = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, readFileSync(join(root, "generative-ui", file), "utf8")]));
        const html = generativeUiExportDocument(input.html, title, libraries);
        const directory = join(agentDir, "artifacts"); mkdirSync(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${randomUUID()}.html`);
        try {
          await inventory.update((entries) => {
            const sessionId = ctx.sessionManager.getSessionId();
            const retained = entries.filter((entry) => entry.sessionId === sessionId);
            const bytes = Buffer.byteLength(input.html, "utf8");
            if (entries.length >= 2000 || retained.length >= MAX_HTML_ARTIFACTS_PER_CHAT || retained.reduce((sum, entry) => sum + entry.bytes, 0) + bytes > MAX_HTML_ARTIFACT_BYTES_PER_CHAT) throw new Error("The stored HTML artifact budget is exhausted.");
            writeFileSync(path, html, { flag: "wx", mode: 0o600 });
            entries.push({ sessionId, path, bytes });
          });
        } catch (error) { rmSync(path, { force: true }); throw error; }
        count++;
        return { content: [{ type: "text", text: `Created ${title}: ${path}` }], details: { path, title } };
      },
    });
  } };
}
