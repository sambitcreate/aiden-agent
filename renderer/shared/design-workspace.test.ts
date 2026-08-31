import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ChatHtmlArtifactV1 } from "./chat-artifacts.js";
import {
  groupDesignWorkspaceArtifacts,
  designWorkspaceArtifactPlan,
  isDesignHtmlArtifact,
  parseDesignElementSelection,
  parseDesignTurnContext,
  resolveDesignWorkspaceSelection,
} from "./design-workspace.js";

function artifact(mediaId: string, id = mediaId): ChatHtmlArtifactV1 {
  return {
    version: 1,
    kind: "html",
    id,
    title: "Checkout",
    mimeType: "text/html",
    size: 20,
    mediaId,
  };
}

test("Design revisions are namespaced, chronological, and replace live by identity", () => {
  const first = artifact("design:first");
  const ordinary = artifact("ordinary");
  const second = artifact("design:second", "persisted");
  const liveSecond = artifact("design:second", "live");
  const liveThird = artifact("design:third", "live-third");
  const plan = designWorkspaceArtifactPlan(
    [
      { role: "assistant", htmlArtifacts: [first, ordinary] },
      { role: "assistant", htmlArtifacts: [second] },
    ],
    [liveSecond, liveThird],
  );
  assert.equal(isDesignHtmlArtifact(first), true);
  assert.equal(isDesignHtmlArtifact(ordinary), false);
  assert.deepEqual(
    plan.map((entry) => [entry.artifact.mediaId, entry.artifact.id, entry.source]),
    [
      ["design:first", "design:first", "persisted"],
      ["design:second", "live", "live"],
      ["design:third", "live-third", "live"],
    ],
  );
});

test("selection follows latest until an older revision is explicitly pinned", () => {
  const first = { artifact: artifact("design:first"), source: "persisted" as const };
  const second = { artifact: artifact("design:second"), source: "persisted" as const };
  const third = { artifact: artifact("design:third"), source: "live" as const };
  assert.equal(resolveDesignWorkspaceSelection(null, null, [first]), "design:first");
  assert.equal(
    resolveDesignWorkspaceSelection("design:first", "design:first", [first, second]),
    "design:second",
  );
  assert.equal(
    resolveDesignWorkspaceSelection("design:first", "design:second", [first, second, third]),
    "design:first",
  );
});

test("same-title artifacts form one ordered artboard revision group", () => {
  const checkoutOne = { artifact: artifact("design:first"), source: "persisted" as const };
  const checkoutTwo = { artifact: artifact("design:second"), source: "persisted" as const };
  const account = {
    artifact: { ...artifact("design:account"), title: "Account" },
    source: "live" as const,
  };
  const groups = groupDesignWorkspaceArtifacts([checkoutOne, account, checkoutTwo]);
  assert.deepEqual(
    groups.map((group) => [
      group.title,
      group.revisions.map((revision) => revision.artifact.mediaId),
    ]),
    [
      ["Checkout", ["design:first", "design:second"]],
      ["Account", ["design:account"]],
    ],
  );
});

test("Design selection context is exact, bounded, and rejects duplicate artboards", () => {
  const selection = {
    version: 1,
    tagName: "button",
    label: "Create account",
    selector: '[data-aiden-id="create-account"]',
    elementId: "create-account",
    role: "button",
    text: "Create account",
  } as const;
  assert.deepEqual(parseDesignElementSelection(selection), selection);
  const target = {
    mediaId: "design:screen-one",
    artifactId: "a".repeat(64),
    selection,
  };
  assert.deepEqual(parseDesignTurnContext({ version: 1, targets: [target] }), {
    version: 1,
    targets: [target],
  });
  assert.equal(parseDesignTurnContext({ version: 1, targets: [target, { ...target }] }), undefined);
  assert.equal(
    parseDesignTurnContext({ version: 1, targets: [{ ...target, extra: true }] }),
    undefined,
  );
  assert.equal(parseDesignElementSelection({ ...selection, selector: "x".repeat(513) }), undefined);
});

test("renderer uses a full-canvas route, one sandbox preview, and compact transcript cards", () => {
  const workspace = readFileSync(
    new URL("../components/design-workspace.tsx", import.meta.url),
    "utf8",
  );
  const messages = readFileSync(new URL("../components/message-list.tsx", import.meta.url), "utf8");
  const card = readFileSync(
    new URL("../components/design-artifact-card.tsx", import.meta.url),
    "utf8",
  );
  assert.match(workspace, /HtmlArtifactIframe/u);
  assert.match(workspace, /ReactFlow/u);
  assert.match(workspace, /CanvasToolRail/u);
  assert.match(workspace, /Visual edits/u);
  assert.match(workspace, /Upload image/u);
  assert.match(workspace, /"desktop"/u);
  assert.match(workspace, /"tablet"/u);
  assert.match(workspace, /"phone"/u);
  assert.match(workspace, /What should we design\?/u);
  assert.match(workspace, /data-design-workspace-canvas/u);
  assert.match(workspace, /data-design-preview-stage/u);
  assert.doesNotMatch(workspace, /role=\{compact \? "dialog"/u);
  assert.doesNotMatch(workspace, /DesignWorkspaceWorkbench/u);
  assert.match(messages, /isDesignHtmlArtifact/u);
  assert.match(messages, /DesignArtifactCard/u);
  assert.match(card, /Design version/u);
  assert.match(card, /to: "\/design\/\$chatId"/u);
});

test("Design is owned by stable routes and never mounts chat-adjacent chrome", () => {
  const router = readFileSync(new URL("../main/router.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("../main/chat-layout.tsx", import.meta.url), "utf8");
  const pane = readFileSync(new URL("../main/chat-pane.tsx", import.meta.url), "utf8");

  assert.match(router, /path: "\/design"/u);
  assert.match(router, /path: "\/design\/\$chatId"/u);
  assert.match(router, /<ChatPane chatId=\{chatId\} presentation="design"/u);
  assert.match(layout, /pathname\.startsWith\("\/design"\)/u);
  assert.match(layout, /export function DesignIndex\(\)/u);
  assert.match(pane, /presentation\?: "chat" \| "design"/u);
  assert.match(pane, /<DesignWorkspaceCanvas/u);
  assert.match(pane, /designContextItems/u);
  assert.match(pane, /DESIGN_TURN_CONTEXT_VERSION/u);
  assert.match(pane, /Open conversation/u);
  assert.match(pane, /overlayFooter=\{presentation === "design"\}/u);
  assert.doesNotMatch(
    readFileSync(new URL("../components/design-workspace.tsx", import.meta.url), "utf8"),
    /pb-40|pb-36/u,
  );
  assert.doesNotMatch(pane, /data-design-workspace-toggle/u);
  assert.doesNotMatch(pane, /DesignWorkspaceWorkbench/u);
});
