import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ChatHtmlArtifactV1 } from "./chat-artifacts.js";
import {
  DesignConnectedDirectEditRetryState,
  DesignProjectPersistenceBarrier,
  DesignPrototypeDirectEditRetryState,
  designProjectClaimsArtifacts,
  durableDesignWorkspaceArtifactGroups,
  groupDesignWorkspaceArtifacts,
  designWorkspaceArtifactPlan,
  isDesignProjectMetadataOnlyUpdate,
  isDesignHtmlArtifact,
  parseDesignElementSelection,
  parseDesignTurnContext,
  resolveDesignWorkspaceSelection,
  resolveDesignArtboardPosition,
  snapshotDesignTurnTargets,
} from "./design-workspace.js";
import type { DesignProjectSnapshotV1 } from "./design-projects.js";

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

function project(overrides: Partial<DesignProjectSnapshotV1> = {}): DesignProjectSnapshotV1 {
  return {
    version: 1,
    id: "project:one",
    revision: 1,
    title: "Original",
    chatId: "chat:one",
    connectionState: "prototype-only",
    createdAt: 1,
    updatedAt: 1,
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
    },
    referenceAssetIds: [],
    ...overrides,
  };
}

test("an immediate send barrier preserves the synchronously selected historical target", async () => {
  const barrier = new DesignProjectPersistenceBarrier<{
    project: DesignProjectSnapshotV1;
    targets: ReturnType<typeof snapshotDesignTurnTargets>;
  }>();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const events: string[] = [];
  const latest = { mediaId: "design:N", artifactId: "n".repeat(64) };
  const historical = { mediaId: "design:H", artifactId: "h".repeat(64) };
  let currentTargets = [latest];
  const first = barrier.flush(async () => {
    events.push("existing-save-started");
    await firstGate;
    events.push("existing-save-finished");
    return { project: project({ revision: 2 }), targets: snapshotDesignTurnTargets([latest]) };
  });
  await Promise.resolve();

  currentTargets = [historical];
  const targetSnapshot = snapshotDesignTurnTargets(currentTargets);
  const immediateSend = barrier.flush(async () => {
    events.push(`saved-${targetSnapshot[0]?.mediaId}`);
    return { project: project({ revision: 3 }), targets: targetSnapshot };
  });
  currentTargets = [latest];
  await Promise.resolve();
  assert.deepEqual(events, ["existing-save-started"]);

  releaseFirst();
  assert.equal((await first).targets[0]?.mediaId, "design:N");
  assert.equal((await immediateSend).targets[0]?.mediaId, "design:H");
  assert.deepEqual(events, ["existing-save-started", "existing-save-finished", "saved-design:H"]);
});

test("prototype direct-edit retries retain one operation and reset on payload change or success", () => {
  const operationIds = [
    "gesture:550e8400-e29b-41d4-a716-446655440000",
    "gesture:550e8400-e29b-41d4-a716-446655440001",
    "gesture:550e8400-e29b-41d4-a716-446655440002",
  ];
  const retries = new DesignPrototypeDirectEditRetryState(() => operationIds.shift()!);
  const payload = {
    projectId: "project:one",
    lineageId: "lineage:one",
    mediaId: "design:base",
    selection: {
      version: 1,
      tagName: "button",
      label: "Save",
      selector: '[data-aiden-id="save"]',
      elementId: "save",
    },
    edit: { kind: "spacing", property: "padding", value: "16px" },
  } as const;

  const first = retries.operationIdFor(payload);
  assert.equal(retries.operationIdFor(structuredClone(payload)), first);
  retries.resetUnless({ ...payload, edit: { ...payload.edit, value: "20px" } });
  const changed = retries.operationIdFor({
    ...payload,
    edit: { ...payload.edit, value: "20px" },
  });
  assert.notEqual(changed, first);
  retries.complete(changed);
  assert.notEqual(
    retries.operationIdFor({ ...payload, edit: { ...payload.edit, value: "20px" } }),
    changed,
  );
});

test("connected direct-edit retries retain one operation until durable acknowledgement", () => {
  const operationIds = [
    "gesture:550e8400-e29b-41d4-a716-446655440010",
    "gesture:550e8400-e29b-41d4-a716-446655440011",
    "gesture:550e8400-e29b-41d4-a716-446655440012",
  ];
  const retries = new DesignConnectedDirectEditRetryState(() => operationIds.shift()!);
  const payload = {
    projectId: "project:one",
    sourceSelectionId: "selection:one",
    edit: { kind: "spacing", property: "padding", value: "16px" },
  } as const;

  const first = retries.operationIdFor(payload);
  assert.equal(retries.operationIdFor(structuredClone(payload)), first);
  retries.resetUnless({ ...payload, sourceSelectionId: "selection:two" });
  const changed = retries.operationIdFor({ ...payload, sourceSelectionId: "selection:two" });
  assert.notEqual(changed, first);
  retries.complete(changed);
  assert.notEqual(
    retries.operationIdFor({ ...payload, sourceSelectionId: "selection:two" }),
    changed,
  );
});

test("renaming preserves same-project direct-edit artifacts and undo state", () => {
  const original = project();
  assert.equal(
    isDesignProjectMetadataOnlyUpdate(
      original,
      project({ revision: 2, title: "Renamed", updatedAt: 2 }),
    ),
    true,
  );
  assert.equal(
    isDesignProjectMetadataOnlyUpdate(
      original,
      project({
        revision: 2,
        updatedAt: 2,
        canvas: {
          ...original.canvas,
          nodes: [
            {
              id: "artboard:one",
              kind: "artboard",
              canonicalOrigin: "generated-artifact",
              x: 0,
              y: 0,
            },
          ],
        },
      }),
    ),
    false,
  );
});

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

test("main-validated model output joins its selected durable lineage without title inference", () => {
  const first = { artifact: artifact("design:first"), source: "persisted" as const };
  const revised = {
    artifact: {
      ...artifact("design:revision", "b".repeat(64)),
      title: "A completely different model title",
      revisionOfMediaId: "design:first",
    },
    source: "live" as const,
  };
  const current = project({
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "design-artboard:one",
          kind: "artboard",
          canonicalOrigin: "generated-artifact",
          x: 0,
          y: 0,
          lineageId: "lineage:one",
          artifactMediaIds: ["design:first"],
          activeMediaId: "design:first",
        },
      ],
    },
  });

  const groups = durableDesignWorkspaceArtifactGroups(current, [first, revised]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.id, "design-artboard:one");
  assert.deepEqual(
    groups[0]?.revisions.map(({ artifact: item }) => item.mediaId),
    ["design:first", "design:revision"],
  );

  const forged = {
    ...revised,
    artifact: {
      ...revised.artifact,
      revisionOfMediaId: "design:missing",
    },
  };
  assert.equal(durableDesignWorkspaceArtifactGroups(current, [first, forged]).length, 2);
  assert.equal(
    durableDesignWorkspaceArtifactGroups(current, [first, { ...forged, source: "persisted" }])
      .length,
    1,
    "a persisted but unpublished revision never reappears in project history",
  );
});

test("optimistic Design revisions remain pending until the project snapshot claims every media ID", () => {
  const first = artifact("design:first");
  const second = artifact("design:second");
  const current = project({
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "design-artboard:one",
          kind: "artboard",
          canonicalOrigin: "generated-artifact",
          x: 0,
          y: 0,
          lineageId: "lineage:one",
          artifactMediaIds: [first.mediaId],
          activeMediaId: first.mediaId,
        },
      ],
    },
  });

  assert.equal(designProjectClaimsArtifacts(current, [first]), true);
  assert.equal(designProjectClaimsArtifacts(current, [first, second]), false);
});

test("publication migrates a dragged provisional position to the durable artboard identity", () => {
  const dragged = { x: 1840, y: 96 };
  const sourceOffset = 1200 + 120;
  const fallback = { x: sourceOffset + (1200 + 120), y: 0 };
  assert.deepEqual(
    resolveDesignArtboardPosition({
      groupId: "design-artboard:durable",
      revisionMediaIds: ["design:new"],
      positionsByNodeId: new Map([["design-artboard:provisional", dragged]]),
      positionsByMediaId: new Map([["design:new", dragged]]),
      fallback,
    }),
    dragged,
  );
  assert.deepEqual(
    resolveDesignArtboardPosition({
      groupId: "design-artboard:unseen",
      revisionMediaIds: ["design:unseen"],
      positionsByNodeId: new Map(),
      positionsByMediaId: new Map(),
      fallback,
    }),
    fallback,
    "an unseen artboard still honors the connected-source offset fallback",
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
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(workspace, /HtmlArtifactIframe/u);
  assert.match(workspace, /ReactFlow/u);
  assert.match(workspace, /CanvasToolRail/u);
  assert.match(workspace, /Visual edits/u);
  assert.match(workspace, /Add reference image/u);
  assert.match(workspace, /TooltipPrimitive\.Root/u);
  assert.match(workspace, /TooltipPrimitive\.Trigger asChild/u);
  assert.match(workspace, /TooltipPrimitive\.Portal/u);
  assert.match(workspace, /TooltipPrimitive\.Content/u);
  assert.match(workspace, /Select and move items on the canvas\./u);
  assert.match(workspace, /Pick an element in a generated screen or running app\./u);
  assert.match(workspace, /Use the interface without selecting its elements\./u);
  assert.match(workspace, /Focus the prompt to describe another screen or flow\./u);
  assert.match(workspace, /Add up to six local images as visual references\./u);
  assert.match(workspace, /Pan around the canvas without moving artboards\./u);
  assert.match(workspace, /aria-keyshortcuts=\{shortcut\}/u);
  assert.match(workspace, /aria-label=\{shortcut \? `\$\{label\} \(\$\{shortcut\}\)` : label\}/u);
  assert.match(workspace, /aria-pressed=\{active\}/u);
  assert.doesNotMatch(workspace, /title=\{shortcut \? `\$\{label\}/u);
  const tool = (label: string) => {
    const start = workspace.indexOf(`label="${label}"`);
    const end = workspace.indexOf("</CanvasToolButton>", start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    return workspace.slice(start, end);
  };
  assert.match(tool("Select"), /active=\{mode === "select"\}/u);
  assert.match(tool("Visual edits"), /active=\{mode === "inspect"\}/u);
  assert.match(tool("Preview"), /active=\{mode === "preview"\}/u);
  assert.match(tool("Hand"), /active=\{mode === "hand"\}/u);
  assert.doesNotMatch(tool("New design"), /active=/u);
  assert.doesNotMatch(tool("Add reference image"), /active=/u);
  assert.match(workspace, /"desktop"/u);
  assert.match(workspace, /"tablet"/u);
  assert.match(workspace, /"phone"/u);
  assert.match(workspace, /What should we design\?/u);
  assert.match(workspace, /data-design-workspace-canvas/u);
  assert.match(workspace, /data-design-preview-stage/u);
  assert.match(
    workspace,
    /setConnectedSource\(undefined\);[\s\S]*setConnectedSourceLoading\(true\)/u,
  );
  assert.match(workspace, /sourceLoading=\{\s*Boolean\(/u);
  assert.match(workspace, /design-canvas-toolbar/u);
  assert.match(workspace, /design-canvas-control/u);
  assert.match(styles, /\.design-canvas-control:focus-visible/u);
  assert.match(styles, /\.react-flow__controls-button:focus-visible/u);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.design-canvas-toolbar/u);
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
  assert.match(
    router,
    /<DesignProjectRoute projectOrLegacyChatId=\{chatId\} initialMediaId=\{artifact\}/u,
  );
  assert.match(layout, /pathname\.startsWith\("\/design"\)/u);
  assert.match(layout, /export function DesignIndex\(\)/u);
  assert.match(layout, /<DesignProjectSidebar/u);
  assert.match(layout, /mode === "design"/u);
  assert.doesNotMatch(layout, /<DesignProjectLibrary/u);
  assert.match(layout, /export function DesignProjectRoute/u);
  assert.match(layout, /designProject=\{project\}/u);
  assert.match(pane, /presentation\?: "chat" \| "design"/u);
  assert.match(pane, /<DesignWorkspaceCanvas/u);
  assert.match(pane, /designContextItems/u);
  assert.match(pane, /DESIGN_TURN_CONTEXT_VERSION/u);
  assert.match(pane, /aria-label="Design Project conversation"/u);
  assert.match(pane, /overlayFooter=\{presentation === "design"\}/u);
  assert.doesNotMatch(
    readFileSync(new URL("../components/design-workspace.tsx", import.meta.url), "utf8"),
    /pb-40|pb-36/u,
  );
  assert.doesNotMatch(pane, /data-design-workspace-toggle/u);
  assert.doesNotMatch(pane, /DesignWorkspaceWorkbench/u);
});
