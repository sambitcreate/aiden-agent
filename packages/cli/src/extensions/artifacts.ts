import { Type } from "typebox";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { generativeUiExportDocument, htmlArtifactByteLength, requireGenerativeUiTitle, validateGenerativeUiHtml } from "../../../../main/services/generative-ui-html.js";
import { HTML_ARTIFACT_MIME_TYPE, MAX_HTML_ARTIFACTS_PER_CHAT, MAX_HTML_ARTIFACTS_PER_RESPONSE, MAX_HTML_ARTIFACT_BYTES_PER_CHAT } from "../../../../renderer/shared/generative-ui.js";
import { CHAT_ARTIFACT_VERSION } from "../../../../renderer/shared/chat-artifacts.js";
import { compileAum } from "../../../../renderer/shared/aiden-ui/compile.js";
import { AIDEN_UI_CATALOG_VERSION } from "../../../../renderer/shared/aiden-ui/types.js";
import { parseChatUiVisualV1 } from "../../../../renderer/shared/aiden-ui/visual.js";
import type { CapturedImage } from "../../../../main/services/visual-snapshot-core.js";
import { JsonStore } from "../state.ts";
import {
  findServerBrowser,
  htmlVisualResultText,
  renderServerVisualImage,
  serverVisualHostPage,
  serverVisualIds,
  serverVisualWidth,
  uiVisualResultText,
  type HostLibraryName,
  type HtmlVisualOutcome,
  type RenderServerVisualOptions,
  type ServerBrowser,
  type ServerVisualCollector,
  type UiVisualOutcome,
} from "../server-visuals.ts";

const LIBRARY_FILES: Record<Exclude<HostLibraryName, "aiden-ui.css">, string> = {
  "chart.js": "chart.umd.min.js",
  "plotly.js": "plotly.min.js",
  "katex.js": "katex.min.js",
  "katex.css": "katex.min.css",
};

export interface ArtifactsExtensionOptions {
  /** Where this turn's visuals go on its reply. Without one, nothing reaches the person's app. */
  visuals?: ServerVisualCollector;
  /** The browser lookup and the renderer; tests replace them. */
  findBrowser?: () => ServerBrowser;
  render?: (options: RenderServerVisualOptions) => Promise<CapturedImage | null>;
}

export function createArtifactsExtension(agentDir: string, options: ArtifactsExtensionOptions = {}): InlineExtension {
  const inventory = new JsonStore<Array<{ sessionId: string; path: string; bytes: number }>>(join(agentDir, "artifacts.json"), []);
  // Looked for when a visual is drawn, never at startup, so serve starts the same with or without a browser.
  const findBrowser = options.findBrowser ?? (() => findServerBrowser({ platform: process.platform, isRoot: process.getuid?.() === 0 }));
  const render = options.render ?? renderServerVisualImage;
  return { name: "aiden-artifacts", factory(pi) {
    let count = 0;
    pi.on("before_agent_start", async () => { count = 0; });
    pi.registerTool({ name: "render_artifact", label: "HTML artifact", description: "Draw an HTML visualization (offline Chart.js, Plotly and KaTeX) in the person's app. This server draws it once as a still picture when it has a browser; the result says whether the person sees it.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 120 }),
        html: Type.String({ minLength: 1, maxLength: 524288 }),
        layout: Type.Optional(Type.Union([Type.Literal("column"), Type.Literal("wide")])),
      }),
      async execute(toolCallId, input, signal, _onUpdate, ctx) {
        if (count >= MAX_HTML_ARTIFACTS_PER_RESPONSE) throw new Error(`At most ${MAX_HTML_ARTIFACTS_PER_RESPONSE} artifacts may be created per response.`);
        const title = requireGenerativeUiTitle(input.title);
        validateGenerativeUiHtml(input.html);
        const root = dirname(process.env.AIDEN_CLI_ENTRY!);
        const library = (name: HostLibraryName) => readFileSync(join(root, "generative-ui", LIBRARY_FILES[name as keyof typeof LIBRARY_FILES]), "utf8");
        const libraries = Object.fromEntries(Object.keys(LIBRARY_FILES).map((name) => [name, library(name as HostLibraryName)]));
        const html = generativeUiExportDocument(input.html, title, libraries);
        const directory = join(agentDir, "artifacts"); mkdirSync(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${randomUUID()}.html`);
        const sessionId = ctx.sessionManager.getSessionId();
        try {
          await inventory.update((entries) => {
            const retained = entries.filter((entry) => entry.sessionId === sessionId);
            const bytes = Buffer.byteLength(input.html, "utf8");
            if (entries.length >= 2000 || retained.length >= MAX_HTML_ARTIFACTS_PER_CHAT || retained.reduce((sum, entry) => sum + entry.bytes, 0) + bytes > MAX_HTML_ARTIFACT_BYTES_PER_CHAT) throw new Error("The stored HTML artifact budget is exhausted.");
            writeFileSync(path, html, { flag: "wx", mode: 0o600 });
            entries.push({ sessionId, path, bytes });
          });
        } catch (error) { rmSync(path, { force: true }); throw error; }
        count++;
        const outcome = await drawHtml();
        return { content: [{ type: "text", text: htmlVisualResultText(title, outcome, path) }], details: { path, title, shown: outcome === "image" } };

        async function drawHtml(): Promise<HtmlVisualOutcome> {
          const collector = options.visuals;
          if (!collector) return "failed";
          if (!collector.canHoldImage(1)) return "full";
          const browser = findBrowser();
          if (browser.kind === "none") return "no-browser";
          if (browser.kind === "root") return "root";
          const width = serverVisualWidth(input.layout);
          const image = await render({ browserPath: browser.path, hostPage: serverVisualHostPage(input.html, title, width, library), width, ...(signal ? { signal } : {}) });
          if (signal?.aborted) throw new Error("Artifact rendering was cancelled.");
          if (!image) return "failed";
          const added = collector.addHtml({
            toolCallId,
            image,
            ...(input.layout === "wide" ? { layout: "wide" as const } : {}),
            artifact: {
              version: CHAT_ARTIFACT_VERSION,
              kind: "html",
              id: createHash("sha256").update(input.html).digest("hex"),
              title,
              mimeType: HTML_ARTIFACT_MIME_TYPE,
              size: htmlArtifactByteLength(input.html),
              mediaId: serverVisualIds(sessionId, toolCallId).mediaId,
            },
          });
          return added ? "image" : "full";
        }
      },
    });
    // The server cannot draw Aiden's native components, so a render_ui visual
    // reaches the person's app as its text rendering, with charts as tables.
    pi.registerTool({ name: "render_ui", label: "Visual", description: "Draw a visual with Aiden's native component catalog (Aiden UI Markup). On this server the person's app shows it as its text rendering, with charts as tables.",
      parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 120 }), layout: Type.Optional(Type.Union([Type.Literal("column"), Type.Literal("wide")])), markup: Type.String({ minLength: 1, maxLength: 400_000 }) }),
      async execute(toolCallId, input, _signal, _onUpdate, ctx) {
        const title = requireGenerativeUiTitle(input.title);
        const compiled = compileAum(input.markup, { fallback: { chartTables: true } });
        if (!compiled.tree) throw new Error("render_ui produced no visual.");
        const repairs = compiled.diagnostics.slice(0, 12).map((diagnostic) => `- ${diagnostic.code}: ${diagnostic.message}`);
        const collector = options.visuals;
        let outcome: UiVisualOutcome = collector?.canHoldUi() ? "failed" : collector ? "full" : "failed";
        if (collector?.canHoldUi()) {
          const visual = parseChatUiVisualV1({
            version: 1,
            kind: "ui",
            id: serverVisualIds(ctx.sessionManager.getSessionId(), toolCallId).uiId,
            title,
            catalogVersion: AIDEN_UI_CATALOG_VERSION,
            tree: compiled.tree,
            ...(compiled.dataJson ? { dataJson: compiled.dataJson } : {}),
            ...(compiled.state ? { state: compiled.state } : {}),
            fallbackText: compiled.fallbackText,
            ...(input.layout === "wide" ? { layout: "wide" } : {}),
          });
          if (visual) outcome = collector.addUi({ toolCallId, visual }) ? "text" : "full";
        }
        return { content: [{ type: "text", text: uiVisualResultText(title, compiled.fallbackText, outcome, repairs) }], details: { title, shown: outcome === "text" } };
      },
    });
  } };
}
