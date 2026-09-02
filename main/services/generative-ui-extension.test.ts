import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  designArtifactUsesDesignSystem,
  createGenerativeUiExtension,
  GENERATIVE_UI_EXTENSION_ID,
  GENERATIVE_UI_TOOL_NAME,
  shouldEnableDesignWorkspace,
  shouldEnableGenerativeUiExtension,
} from "./generative-ui-extension.js";

test("design-system golden validation requires a visible named token or reviewed component", () => {
  const context = {
    tokens: { colors: [{ name: "color.action.primary", value: "#635bff" }] },
    components: [{ name: "PrimaryButton" }],
  };
  assert.equal(
    designArtifactUsesDesignSystem(
      `<style>:root{--color-action-primary:#635bff}.cta{background:var(--color-action-primary)}</style><button class="cta">Pay</button>`,
      context,
    ),
    true,
  );
  assert.equal(
    designArtifactUsesDesignSystem(`<button style="background:#ff0000">Pay</button>`, context),
    false,
  );
});
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import { DESIGN_ARTIFACT_MEDIA_ID_PREFIX } from "../../renderer/shared/design-workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-genui-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("ordinary and Design artifact gates preserve their separate authority boundaries", () => {
  assert.equal(
    shouldEnableGenerativeUiExtension({
      usageSource: "chat",
      assistantMode: false,
      workspaceRoot: "/tmp/ws",
      permission: "ask",
      excluded: false,
    }),
    true,
  );
  assert.equal(
    shouldEnableGenerativeUiExtension({
      usageSource: "chat",
      interactionSurface: "telegram",
      assistantMode: false,
      workspaceRoot: "/tmp/ws",
      permission: "ask",
      excluded: false,
    }),
    false,
  );
  assert.equal(
    shouldEnableGenerativeUiExtension({
      usageSource: "chat",
      assistantMode: true,
      workspaceRoot: "/tmp/ws",
      permission: "ask",
      excluded: false,
    }),
    false,
  );
  assert.equal(
    shouldEnableDesignWorkspace({
      usageSource: "chat",
      assistantMode: false,
      permission: "none",
      excluded: false,
      botBound: false,
      project: { connectionState: "prototype-only" },
    }),
    true,
  );
  for (const blocked of [
    { interactionSurface: "telegram" },
    { assistantMode: true },
    { excluded: true },
    { botBound: true },
  ]) {
    assert.equal(
      shouldEnableDesignWorkspace({
        usageSource: "chat",
        assistantMode: false,
        permission: "ask",
        excluded: false,
        botBound: false,
        project: { connectionState: "prototype-only" },
        ...blocked,
      }),
      false,
    );
  }
  assert.equal(
    shouldEnableDesignWorkspace({
      usageSource: "chat",
      assistantMode: false,
      permission: "ask",
      excluded: false,
      botBound: false,
    }),
    false,
  );
  assert.equal(
    shouldEnableDesignWorkspace({
      usageSource: "chat",
      assistantMode: false,
      workspaceRoot: "/tmp/ws",
      workspaceId: "workspace-1",
      permission: "ask",
      excluded: false,
      botBound: false,
      project: { connectionState: "connected", workspaceId: "workspace-1" },
    }),
    true,
  );
  assert.equal(
    shouldEnableDesignWorkspace({
      usageSource: "chat",
      assistantMode: false,
      workspaceId: "workspace-1",
      permission: "ask",
      excluded: false,
      botBound: false,
      project: { connectionState: "connected", workspaceId: "workspace-1" },
    }),
    false,
  );
  assert.equal(
    shouldEnableDesignWorkspace({
      usageSource: "chat",
      assistantMode: false,
      workspaceRoot: "/tmp/ws",
      workspaceId: "workspace-2",
      permission: "ask",
      excluded: false,
      botBound: false,
      project: { connectionState: "connected", workspaceId: "workspace-1" },
    }),
    false,
  );
  assert.equal(
    shouldEnableDesignWorkspace({
      usageSource: "chat",
      assistantMode: false,
      workspaceRoot: "/tmp/ws",
      workspaceId: "workspace-1",
      permission: "none",
      excluded: false,
      botBound: false,
      project: { connectionState: "connected", workspaceId: "workspace-1" },
    }),
    false,
  );
  assert.equal(
    shouldEnableDesignWorkspace({
      usageSource: "chat",
      assistantMode: false,
      workspaceRoot: "/tmp/ws",
      permission: "ask",
      excluded: false,
      botBound: true,
      project: { connectionState: "connected", workspaceId: "workspace-1" },
      workspaceId: "workspace-1",
    }),
    false,
  );
});

test("repository-free Design accepts inline HTML without granting ordinary path authority", async () => {
  const artifacts: ChatHtmlArtifactV1[] = [];
  const extension = createGenerativeUiExtension({
    designWorkspaceThisTurn: true,
    onArtifact: (artifact) => {
      artifacts.push(artifact);
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await tool.execute("prototype", {
    title: "Repository-free prototype",
    html: "<main><h1>Prototype</h1></main>",
  });
  assert.equal(artifacts.length, 1);
  assert.match(artifacts[0]?.mediaId ?? "", /^design:/u);

  assert.throws(
    () =>
      createGenerativeUiExtension({
        onArtifact: () => undefined,
      }),
    /workspace root is required/iu,
  );
});

test("render_artifact emits metadata only and never returns HTML to the model", async () => {
  const root = await workspace();
  const artifacts: ChatHtmlArtifactV1[] = [];
  const htmlBodies: string[] = [];
  const extension = createGenerativeUiExtension({
    workspaceRoot: root,
    onArtifact: (artifact, html) => {
      artifacts.push(artifact);
      htmlBodies.push(html);
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  assert.equal(extension.id, GENERATIVE_UI_EXTENSION_ID);
  assert.equal(tool.name, GENERATIVE_UI_TOOL_NAME);
  assert.equal(piRuntimeReplayPolicy(tool), "never");
  const html = '<h1>Chart</h1><canvas id="c"></canvas>';
  const result = await tool.execute("call-1", { title: "Chart", html });
  assert.equal(result.content[0]?.type, "text");
  assert.doesNotMatch(result.content[0]?.type === "text" ? result.content[0].text : "", /<canvas/u);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.title, "Chart");
  assert.equal(htmlBodies[0], html);
});

test("render_artifact rejects path escapes, oversize HTML, and cancelled work", async () => {
  const root = await workspace();
  let emitted = 0;
  const extension = createGenerativeUiExtension({
    workspaceRoot: root,
    onArtifact: () => {
      emitted += 1;
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await assert.rejects(tool.execute("abs", { title: "X", path: "/tmp/x.html" }), /relative/iu);
  await assert.rejects(tool.execute("esc", { title: "X", path: "../x.html" }), /outside/iu);
  await assert.rejects(
    tool.execute("both", { title: "X", html: "<p>a</p>", path: "a.html" }),
    /exactly one/iu,
  );
  const huge = `<p>${"n".repeat(512 * 1024)}</p>`;
  await assert.rejects(tool.execute("huge", { title: "X", html: huge }), /exceeds/iu);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    tool.execute("cancel", { title: "X", html: "<p>ok</p>" }, abort.signal),
    /cancelled/iu,
  );
  assert.equal(emitted, 0);
});

test("same-generation title replaces the previous staged artifact", async () => {
  const root = await workspace();
  const artifacts: ChatHtmlArtifactV1[] = [];
  const extension = createGenerativeUiExtension({
    workspaceRoot: root,
    artifactNamespace: "gen-1",
    onArtifact: (artifact) => {
      artifacts.push(artifact);
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await tool.execute("call-a", { title: "Chart", html: "<p>aaa</p>" });
  await tool.execute("call-b", { title: "Chart", html: "<p>bbb</p>" });
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0]?.mediaId, artifacts[1]?.mediaId);
  assert.equal(artifacts[0]?.size, artifacts[1]?.size);
  assert.notEqual(artifacts[0]?.id, artifacts[1]?.id);
});

test("Design workspace renders inline-only prefixed revisions with bounded prior context", async () => {
  const root = await workspace();
  const artifacts: ChatHtmlArtifactV1[] = [];
  const priorHtml =
    '<!doctype html><html><body><main data-aiden-id="home">Old</main></body></html>';
  const extension = createGenerativeUiExtension({
    workspaceRoot: root,
    designWorkspaceThisTurn: true,
    priorDesign: { title: "Storefront", html: priorHtml },
    onArtifact: (artifact) => {
      artifacts.push(artifact);
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  assert.match(extension.systemPrompt ?? "", /Design workspace is open/u);
  assert.match(extension.systemPrompt ?? "", /one complete artifact per requested screen/u);
  assert.match(extension.systemPrompt ?? "", /same title when revising/u);
  assert.doesNotMatch(JSON.stringify(tool.parameters), /workspace-relative/u);
  await assert.rejects(
    tool.execute("path", { title: "Storefront", path: "index.html" }),
    /inline HTML/iu,
  );
  await tool.execute("inline", {
    title: "Storefront",
    html: '<!doctype html><html><body><main data-aiden-id="home">New</main></body></html>',
  });
  assert.equal(artifacts.length, 1);
  assert.ok(artifacts[0]?.mediaId.startsWith(DESIGN_ARTIFACT_MEDIA_ID_PREFIX));

  const historicalHtmlCanary = "HISTORICAL_DESIGN_HTML_MUST_NOT_REACH_PROVIDER";
  const historicalAssistant: AssistantMessage = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "old-render",
        name: GENERATIVE_UI_TOOL_NAME,
        arguments: { title: "Storefront", html: `<main>${historicalHtmlCanary}</main>` },
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
  const transformed = await extension.transformContext?.([
    historicalAssistant,
    { role: "user", content: "Make the hero quieter", timestamp: 2 },
  ]);
  assert.equal(transformed?.length, 3);
  assert.doesNotMatch(JSON.stringify(transformed), new RegExp(historicalHtmlCanary, "u"));
  assert.match(JSON.stringify(transformed?.[0]), /Previous Design HTML omitted by Aiden/u);
  assert.equal(transformed?.[1]?.role, "user");
  assert.match(
    transformed?.[1]?.role === "user" && typeof transformed[1].content === "string"
      ? transformed[1].content
      : "",
    /untrusted reference data/u,
  );
  assert.match(
    transformed?.[1]?.role === "user" && typeof transformed[1].content === "string"
      ? transformed[1].content
      : "",
    /data-aiden-id/u,
  );
  assert.equal(
    transformed?.[2]?.role === "user" && typeof transformed[2].content === "string"
      ? transformed[2].content
      : "",
    "Make the hero quieter",
  );
});

test("Design context carries multiple exact artboards and a bounded element descriptor", async () => {
  const root = await workspace();
  const extension = createGenerativeUiExtension({
    workspaceRoot: root,
    designWorkspaceThisTurn: true,
    priorDesigns: [
      {
        title: "Checkout",
        html: '<main data-aiden-id="checkout">Checkout</main>',
        selection: {
          tagName: "button",
          label: "Pay now",
          selector: '[data-aiden-id="pay-now"]',
          elementId: "pay-now",
        },
      },
      {
        title: "Receipt",
        html: '<main data-aiden-id="receipt">Receipt</main>',
      },
    ],
    onArtifact: () => undefined,
  });
  const transformed = await extension.transformContext?.([
    { role: "user", content: "Unify these screens", timestamp: 3 },
  ]);
  assert.equal(transformed?.length, 2);
  const context = transformed?.[0]?.role === "user" ? transformed[0].content : "";
  assert.equal(typeof context, "string");
  assert.match(String(context), /Checkout/u);
  assert.match(String(context), /Receipt/u);
  assert.match(String(context), /pay-now/u);
  assert.match(String(context), /untrusted reference data/u);
});

test("Design context carries the exact normalized design-system preview as untrusted data", async () => {
  const root = await workspace();
  const modelContext = {
    name: "Acme UI",
    tokens: { colors: [{ name: "color.action.primary", value: "#635bff" }] },
    components: [{ name: "Button", variants: ["primary"], states: ["disabled"] }],
    icons: [{ name: "ArrowRight", tags: ["navigation"] }],
  };
  const extension = createGenerativeUiExtension({
    workspaceRoot: root,
    designWorkspaceThisTurn: true,
    designSystemContext: modelContext,
    onArtifact: () => undefined,
  });
  const transformed = await extension.transformContext?.([
    { role: "user", content: "Design a checkout", timestamp: 4 },
  ]);
  assert.equal(transformed?.length, 2);
  const context = transformed?.[0]?.role === "user" ? transformed[0].content : "";
  assert.match(String(context), /Attached design system/u);
  assert.match(String(context), /color\.action\.primary/u);
  assert.match(String(context), /untrusted reference data/u);
  assert.doesNotMatch(String(context), /sourceHash|workspaceRelativePath/u);
  assert.deepEqual(JSON.parse(JSON.stringify(modelContext)), modelContext);
});

test("Design context always omits historical render HTML when no stored revision is available", async () => {
  const root = await workspace();
  const extension = createGenerativeUiExtension({
    workspaceRoot: root,
    designWorkspaceThisTurn: true,
    onArtifact: () => undefined,
  });
  const canary = "NO_PRIOR_DESIGN_HISTORY_CANARY";
  const historicalAssistant: AssistantMessage = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "old-render",
        name: GENERATIVE_UI_TOOL_NAME,
        arguments: { title: "Dashboard", html: `<main>${canary}</main>` },
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
  const transformed = await extension.transformContext?.([
    historicalAssistant,
    { role: "user", content: "Start over", timestamp: 2 },
  ]);
  assert.doesNotMatch(JSON.stringify(transformed), new RegExp(canary, "u"));
  assert.match(JSON.stringify(transformed), /Previous Design HTML omitted by Aiden/u);
});

test("render_artifact refuses intermediate directory symlinks", async () => {
  if (process.platform !== "darwin") return;
  const root = await workspace();
  const outside = await workspace();
  await fs.writeFile(path.join(outside, "secret.html"), "<p>secret</p>");
  await fs.mkdir(path.join(root, "plots"));
  await fs.symlink(outside, path.join(root, "plots", "leak"));
  const extension = createGenerativeUiExtension({
    workspaceRoot: root,
    onArtifact: () => undefined,
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await assert.rejects(
    tool.execute("symlink", { title: "Leak", path: path.join("plots", "leak", "secret.html") }),
    /could not be read safely/iu,
  );
});

test("render_artifact reads nested HTML through a canonicalized root alias", async () => {
  if (process.platform !== "darwin") return;
  const root = await workspace();
  const aliasParent = await workspace();
  const alias = path.join(aliasParent, "workspace-link");
  await fs.mkdir(path.join(root, "plots"));
  await fs.writeFile(path.join(root, "plots", "chart.html"), "<p>workspace chart</p>");
  await fs.symlink(root, alias);
  const htmlBodies: string[] = [];
  const extension = createGenerativeUiExtension({
    workspaceRoot: alias,
    onArtifact: (_artifact, html) => {
      htmlBodies.push(html);
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);

  await tool.execute("root-alias", {
    title: "Chart",
    path: path.join("plots", "chart.html"),
  });
  assert.deepEqual(htmlBodies, ["<p>workspace chart</p>"]);
});
