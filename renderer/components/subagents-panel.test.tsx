import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DOMImplementation } from "@xmldom/xmldom";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  SubagentMessageReferenceV1,
  SubagentRunSnapshotV1,
  SubagentRunSnapshotV2,
} from "../shared/subagent-runs.js";
import type {
  SubagentMcpMutationApprovalDetails,
  SubagentWorkspaceWriteApprovalDetails,
} from "../shared/assistant.js";
import { mergeSubagentSnapshots, type SubagentRunView } from "../lib/subagent-view-state.js";
import {
  ENVIRONMENT_COMPACT_MODAL_FOCUSABLE_SELECTOR,
  environmentCompactModalFocusableTargets,
  environmentCompactModalTabWrapTarget,
} from "../lib/environment-panel-state.js";
import {
  SubagentLiveAnnouncementCoordinator,
  captureSubagentChipFocus,
  focusSubagentRosterRun,
  resolveSubagentChipFocusHandoff,
  retainSubagentChipFocusAfterPointerDown,
  shouldRestoreSubagentDetailFocus,
  subagentDetailAnnouncement,
  subagentDetailFocusFrame,
  subagentDetailGrowthAction,
  subagentDetailIsAwayFromLatest,
  subagentDetailPendingLoading,
  subagentDetailPresentation,
  subagentDetailRestoreRunId,
  subagentLiveSummary,
  subagentPanelBreakpointFocusTarget,
  subagentPanelOwnerKey,
  subagentPanelSelectionState,
  subagentSnapshotLiveSummary,
  subagentSnapshotLiveSummaryIsTerminal,
  type SubagentChipFocusTarget,
} from "../lib/subagent-panel-state.js";
import {
  SubagentChips,
  SubagentOrb,
  subagentOrbState,
  subagentStatusLabel,
} from "./subagent-chips.js";
import { SubagentOwnerFocusBoundary } from "./subagent-owner-focus-boundary.js";
import { useSubagentSelectionRestoreRunRepair } from "./subagent-owner-focus-boundary.js";
import {
  SubagentLiveAnnouncer,
  type SubagentDetailAnnouncementRequest,
} from "./subagent-live-announcer.js";
import { groupSubagentRuns, SubagentRoster } from "./subagent-roster.js";
import { SubagentDetail } from "./subagent-detail.js";
import { SubagentsPanel } from "./subagents-panel.js";
import { SubagentWorkspaceWriteApproval } from "./subagent-workspace-write-approval.js";
import {
  SubagentMcpMutationApproval,
  subagentMcpMutationAllowLabel,
} from "./subagent-mcp-mutation-approval.js";

function run(runId: string, extra: Partial<SubagentRunSnapshotV1> = {}): SubagentRunSnapshotV1 {
  return {
    version: 1,
    runId,
    groupId: "group-1",
    generationId: "generation-1",
    childId: `child-${runId}`,
    chatId: "chat-1",
    workspaceId: "workspace-1",
    revision: 1,
    role: "scout",
    label: "Code scout",
    taskPreview: "Review the renderer integration",
    state: "running",
    activity: "Reading component boundaries",
    startedAt: 1_000,
    updatedAt: 2_000,
    modelId: "test-model",
    turns: 2,
    tools: 3,
    tokens: 120,
    warnings: [],
    ...extra,
  };
}

function v2Run(extra: Partial<SubagentRunSnapshotV2> = {}): SubagentRunSnapshotV2 {
  return {
    ...run("v2-run"),
    version: 2,
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 3,
    ...extra,
  };
}

function reference(runIds: string[]): SubagentMessageReferenceV1 {
  return {
    version: 1,
    generationId: "generation-1",
    runIds,
    total: runIds.length,
    completed: 1,
    failed: 0,
    timedOut: 0,
    interrupted: 0,
  };
}

function view(snapshot: SubagentRunSnapshotV1 | SubagentRunSnapshotV2): SubagentRunView {
  return {
    runId: snapshot.runId,
    generationId: snapshot.generationId,
    label: snapshot.label,
    role: snapshot.role,
    state: snapshot.state,
    terminal: snapshot.finishedAt !== undefined,
    source: "live",
    sortKey: `${snapshot.startedAt}:${snapshot.runId}`,
    snapshot,
  };
}

interface MountedDom {
  document: Document;
  container: HTMLElement;
  outside: HTMLElement;
  restore: () => void;
}

let mountedDomTestQueue = Promise.resolve();

async function acquireMountedDomTest(): Promise<() => void> {
  const previous = mountedDomTestQueue;
  let release: () => void = () => undefined;
  mountedDomTestQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

function installMountedDom(): MountedDom {
  const document = new DOMImplementation().createDocument(
    null,
    "html",
    null,
  ) as unknown as Document;
  const body = document.createElement("body");
  const container = document.createElement("div");
  const outside = document.createElement("button");
  body.appendChild(container);
  body.appendChild(outside);
  document.documentElement.appendChild(body);

  const elementPrototype = Object.getPrototypeOf(document.createElement("div")) as HTMLElement &
    Record<string, unknown>;
  elementPrototype.addEventListener = () => undefined;
  elementPrototype.removeEventListener = () => undefined;
  elementPrototype.getContext = () =>
    new Proxy(
      {},
      {
        get: () => () => undefined,
        set: () => true,
      },
    );
  if (!elementPrototype.contains) {
    elementPrototype.contains = function contains(target: Node | null) {
      let current = target;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    };
  }
  elementPrototype.querySelector = function querySelector(selector: string) {
    const matches = (element: Element) => {
      if (selector === "[data-subagent-empty-heading]")
        return element.hasAttribute("data-subagent-empty-heading");
      if (selector === "[data-subagent-detail-heading]")
        return element.hasAttribute("data-subagent-detail-heading");
      if (selector === '[data-subagent-run-id][aria-current="true"]')
        return (
          element.hasAttribute("data-subagent-run-id") &&
          element.getAttribute("aria-current") === "true"
        );
      return selector === "[data-subagent-run-id]" && element.hasAttribute("data-subagent-run-id");
    };
    const queue = this.childNodes ? Array.from(this.childNodes) : [];
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (candidate?.nodeType === 1 && matches(candidate as Element)) return candidate;
      if (candidate?.childNodes) queue.push(...Array.from(candidate.childNodes));
    }
    return null;
  };
  elementPrototype.focus = function focus() {
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      value: this,
      writable: true,
    });
  };
  Object.defineProperty(elementPrototype, "isConnected", {
    configurable: true,
    get() {
      let current: Node | null = this as unknown as Node;
      while (current?.parentNode) current = current.parentNode;
      return current === (this as unknown as Node).ownerDocument;
    },
  });
  Object.defineProperty(elementPrototype, "style", {
    configurable: true,
    get() {
      return {};
    },
  });
  Object.defineProperty(elementPrototype, "dataset", {
    configurable: true,
    get() {
      return {
        subagentRunId:
          (this as unknown as Element).getAttribute("data-subagent-run-id") ?? undefined,
      };
    },
  });
  const documentPrototype = Object.getPrototypeOf(document) as Document;
  documentPrototype.addEventListener = () => undefined;
  documentPrototype.removeEventListener = () => undefined;
  Object.defineProperty(document, "body", {
    configurable: true,
    value: body,
  });
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    value: body,
    writable: true,
  });

  const window = {
    document,
    event: undefined,
    HTMLIFrameElement: class HTMLIFrameElement {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    matchMedia: () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  };
  Object.defineProperty(document, "defaultView", {
    configurable: true,
    value: window,
  });
  const globals = [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "matchMedia",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const;
  const previous = new Map<PropertyKey, PropertyDescriptor | undefined>(
    globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const elementConstructor = Object.getPrototypeOf(document.documentElement).constructor;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: document },
    navigator: {
      configurable: true,
      value: { userAgent: "node-subagent-focus-test" },
    },
    Node: { configurable: true, value: elementConstructor },
    Element: { configurable: true, value: elementConstructor },
    HTMLElement: { configurable: true, value: elementConstructor },
    matchMedia: { configurable: true, value: window.matchMedia },
    requestAnimationFrame: { configurable: true, value: window.requestAnimationFrame },
    cancelAnimationFrame: { configurable: true, value: window.cancelAnimationFrame },
  });

  return {
    document,
    container,
    outside,
    restore: () => {
      for (const key of globals) {
        const descriptor = previous.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function mountedElementsWithAttribute(document: Document, attribute: string): HTMLElement[] {
  return Array.from(document.getElementsByTagName("*")).filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element.hasAttribute(attribute),
  );
}

function MountedSelectionRepairHarness({
  compact,
  compactView,
  focusedSurface,
  requestedRunId,
  runIds,
}: {
  compact: boolean;
  compactView: "detail" | "roster";
  focusedSurface: "back" | "detail";
  requestedRunId: string;
  runIds: readonly string[];
}) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const restoreRunIdRef = React.useRef<string | null>(requestedRunId);
  const previousCompactRef = React.useRef(compact);
  const selectedRunId = runIds.includes(requestedRunId) ? requestedRunId : (runIds[0] ?? null);
  useSubagentSelectionRestoreRunRepair(
    restoreRunIdRef,
    selectedRunId,
    runIds.map((runId) => ({ runId })),
  );

  React.useLayoutEffect(() => {
    const breakpointChanged = previousCompactRef.current !== compact;
    previousCompactRef.current = compact;
    const returningFromDetail = compact && compactView === "roster";
    const breakpointReturnsToRoster = breakpointChanged && focusedSurface === "back";
    if (!returningFromDetail && !breakpointReturnsToRoster) return;
    focusSubagentRosterRun(
      Array.from(rootRef.current?.getElementsByTagName("button") ?? []).filter((button) =>
        button.hasAttribute("data-subagent-run-id"),
      ),
      restoreRunIdRef.current,
    );
  }, [compact, compactView, focusedSurface, runIds]);

  const roster = runIds.map((runId) => (
    <button key={runId} type="button" data-subagent-run-id={runId}>
      {runId}
    </button>
  ));
  return (
    <div ref={rootRef}>
      {!compact || compactView === "roster" ? (
        roster
      ) : (
        <>
          <button type="button" data-subagent-back="true">
            Back
          </button>
          <h2 tabIndex={-1} data-subagent-detail-heading="true">
            {selectedRunId}
          </h2>
        </>
      )}
    </div>
  );
}

function MountedLiveAnnouncerHarness({
  detailRequest,
  host,
  runs,
}: {
  detailRequest: SubagentDetailAnnouncementRequest | null;
  host: HTMLElement;
  runs: readonly SubagentRunSnapshotV1[];
}) {
  return (
    <SubagentLiveAnnouncer
      ownerKey={subagentPanelOwnerKey("chat-1", "workspace-1")}
      runs={runs}
      detailRequest={detailRequest}
      portalHost={host}
    />
  );
}

test("subagent chips are accessible buttons with live or frozen ThinkingOrbs", () => {
  const runs = [
    run("active", { label: "Active scout" }),
    run("done", {
      label: "Finished reviewer",
      role: "reviewer",
      state: "completed",
      finishedAt: 3_000,
    }),
  ];
  const markup = renderToStaticMarkup(
    <SubagentChips
      reference={reference(["active", "done"])}
      runs={runs}
      onOpen={() => undefined}
    />,
  );

  assert.equal((markup.match(/<button/gu) ?? []).length, 2);
  assert.match(markup, /aria-label="Open Active scout\. Status: Reading component boundaries\."/u);
  assert.match(markup, /aria-label="Open Finished reviewer\. Status: Finished\."/u);
  assert.match(markup, /data-subagent-chip-run-id="active"/u);
  assert.match(markup, /data-subagent-chip-run-id="done"/u);
  assert.match(markup, /data-subagent-orb-state="active"/u);
  assert.match(markup, /data-subagent-orb-state="terminal"/u);
  assert.match(markup, />Reading component boundaries</u);
  assert.match(markup, />Finished</u);
  assert.doesNotMatch(markup, /role="status"/u);
  assert.doesNotMatch(markup, /aria-live=/u);
  assert.doesNotMatch(
    markup,
    /1 active subagent; 1 done\. Active scout: Reading component boundaries\./u,
  );
});

test("archived chips use embedded terminal metadata without loading snapshots", () => {
  const savedReference: SubagentMessageReferenceV1 = {
    ...reference(["saved"]),
    items: [
      {
        runId: "saved",
        label: "Saved reviewer",
        role: "reviewer",
        state: "failed",
      },
    ],
    completed: 0,
    failed: 1,
  };
  const markup = renderToStaticMarkup(
    <SubagentChips reference={savedReference} onOpen={() => undefined} />,
  );

  assert.match(markup, /aria-label="Open Saved reviewer\. Status: Failed\."/u);
  assert.match(markup, />Saved reviewer</u);
  assert.match(markup, />Failed</u);
  assert.match(markup, /data-subagent-orb-state="terminal"/u);
});

test("streaming chips render ordered live snapshots before a message reference exists", () => {
  const markup = renderToStaticMarkup(
    <SubagentChips
      runs={[run("first", { label: "First scout" }), run("second", { label: "Second scout" })]}
      onOpen={() => undefined}
    />,
  );

  assert.match(markup, /aria-label="2 subagents"/u);
  assert.match(markup, /role="group"/u);
  assert.ok(markup.indexOf("First scout") < markup.indexOf("Second scout"));
  assert.equal(renderToStaticMarkup(<SubagentChips runs={[]} onOpen={() => undefined} />), "");
});

test("V2 detail exposes context but gates controls on production callbacks", () => {
  const fresh = v2Run();
  const unavailable = renderToStaticMarkup(<SubagentDetail run={fresh} />);
  assert.match(unavailable, /Fresh context/u);
  assert.doesNotMatch(unavailable, /data-subagent-controls/u);

  const stoppable = renderToStaticMarkup(<SubagentDetail run={fresh} onStop={() => undefined} />);
  assert.match(stoppable, /data-subagent-controls="true"/u);
  assert.match(stoppable, /aria-label="Stop subtree Code scout"/u);
  assert.doesNotMatch(stoppable, /aria-label="Retry Code scout"/u);

  const forked = v2Run({
    state: "completed",
    context: "fork",
    activity: undefined,
    finishedAt: 2_000,
    terminalMarkdown: "Done.",
  });
  const retryable = renderToStaticMarkup(<SubagentDetail run={forked} />);
  assert.match(retryable, /Forked conversation/u);
  assert.doesNotMatch(retryable, /aria-label="Retry Code scout"/u);

  const legacy = renderToStaticMarkup(
    <SubagentDetail run={run("legacy")} onStop={() => undefined} />,
  );
  assert.doesNotMatch(legacy, /data-subagent-context/u);
  assert.doesNotMatch(legacy, /data-subagent-controls/u);
});

test("detail renders bounded effect kind, state, and explicit unknown guidance", () => {
  const html = renderToStaticMarkup(
    <SubagentDetail
      run={v2Run()}
      effectActivity={[
        {
          version: 1,
          kind: "mcp_mutation",
          state: "unknown",
          label: "Remote change outcome unknown. Check the remote system before retrying.",
          updatedAt: 2_100,
        },
      ]}
    />,
  );
  assert.match(html, /External effects/u);
  assert.match(html, /data-subagent-effect-kind="mcp_mutation"/u);
  assert.match(html, /data-subagent-effect-state="unknown"/u);
  assert.match(html, /Check the remote system before retrying/u);
  assert.match(html, /State: unknown/u);
  assert.doesNotMatch(html, /terminalDigest|authorityDigest|argumentDigest/u);
});

test("workspace-write approvals render exact bounded safety facts and stay wired to deny-first controls", () => {
  const details: SubagentWorkspaceWriteApprovalDetails = {
    kind: "subagent-workspace-write",
    operation: "edit",
    childLabel: "Correct parser",
    path: "renderer/shared/assistant.ts",
    workspaceLabel: "Aiden",
    worktreeLabel: "feature/approval-ui",
    isManagedWorktree: true,
    preDigestPrefix: "0123456789ab",
    postDigestPrefix: "abcdef012345",
    beforeBytes: 1_024,
    afterBytes: 2_048,
    diffPreview: "- old parser\n+ strict parser",
    diffTruncated: true,
    commandWillRun: false,
    refuseIfChanged: true,
  };
  const markup = renderToStaticMarkup(
    <SubagentWorkspaceWriteApproval details={details} descriptionId="approval-description" />,
  );

  assert.match(markup, /data-subagent-write-approval="true"/u);
  assert.match(markup, /id="approval-description"/u);
  assert.match(markup, />Edit file</u);
  assert.match(markup, /renderer\/shared\/assistant\.ts/u);
  assert.match(markup, />Aiden</u);
  assert.match(markup, />feature\/approval-ui</u);
  assert.match(markup, /0123456789ab · 1\.0 KB/u);
  assert.match(markup, /abcdef012345 · 2\.0 KB/u);
  assert.match(markup, /Change preview · truncated/u);
  assert.match(markup, /- old parser[\s\S]*\+ strict parser/u);
  assert.match(markup, /No command will run\./u);
  assert.match(markup, /refuse this change if the workspace or file has drifted/u);

  const chatPaneSource = readFileSync(new URL("../main/chat-pane.tsx", import.meta.url), "utf8");
  const approvalCard = chatPaneSource.slice(
    chatPaneSource.indexOf("present={Boolean(pending)}"),
    chatPaneSource.indexOf("<Composer", chatPaneSource.indexOf("present={Boolean(pending)}")),
  );
  assert.match(chatPaneSource, /isSubagentWorkspaceWriteApprovalDetails\(pending\.details\)/u);
  assert.match(chatPaneSource, /pendingWorkspaceWriteClaim/u);
  assert.match(chatPaneSource, /Invalid privileged approval blocked/u);
  assert.match(chatPaneSource, /invalidPendingPrivilegedApproval \? null/u);
  assert.match(chatPaneSource, /decidingApprovalRef\.current/u);
  assert.match(chatPaneSource, /if \(decidingApprovalRef\.current\) return/u);
  assert.match(approvalCard, /SubagentWorkspaceWriteApproval/u);
  assert.ok(
    approvalCard.indexOf("ref={approvalDenyRef}") < approvalCard.indexOf("Allow once"),
    "Deny remains the first and default-focused approval action",
  );
  assert.doesNotMatch(approvalCard, /Always allow|Allow all/u);
});

test("mutation approvals expose fixed risk copy, prior-unknown semantics, and deny-first controls", () => {
  const details: SubagentMcpMutationApprovalDetails = {
    kind: "subagent-mcp-mutation",
    childLabel: "Publisher",
    serverId: "docs",
    toolName: "publish",
    connectionDigestPrefix: "aaaaaaaaaaaa",
    schemaDigestPrefix: "bbbbbbbbbbbb",
    profileDigestPrefix: "cccccccccccc",
    argumentDigestPrefix: "dddddddddddd",
    classification: "unproven_mutating",
    destructive: "unknown",
    idempotency: "not_declared",
    openWorld: "unknown",
    taskSupport: "optional",
    timeoutMs: 30_000,
    canonicalArguments: '{"title":"Launch"}',
    priorUnknownEffect: true,
    automaticRetry: false,
    rollbackAvailable: false,
  };
  const markup = renderToStaticMarkup(
    <SubagentMcpMutationApproval details={details} descriptionId="mutation-approval-description" />,
  );
  assert.match(markup, /data-subagent-mcp-mutation-approval="true"/u);
  assert.match(markup, /Complete canonical MCP mutation arguments/u);
  assert.match(markup, /Mutation cannot be ruled out/u);
  assert.match(markup, /configured server controls the effect/u);
  assert.match(markup, /Data outside Aiden may change/u);
  assert.match(markup, /Rollback is unavailable/u);
  assert.match(markup, /outcome unknown/u);
  assert.match(markup, /Automatic retry is disabled/u);
  assert.match(markup, /prior call to this target has an unknown outcome/u);
  assert.equal(subagentMcpMutationAllowLabel(details), "Allow once after unknown outcome");

  const chatPaneSource = readFileSync(new URL("../main/chat-pane.tsx", import.meta.url), "utf8");
  const approvalCard = chatPaneSource.slice(
    chatPaneSource.indexOf("present={Boolean(pending)}"),
    chatPaneSource.indexOf("<Composer", chatPaneSource.indexOf("present={Boolean(pending)}")),
  );
  assert.match(chatPaneSource, /isSubagentMcpMutationApprovalDetails\(pending\.details\)/u);
  assert.match(chatPaneSource, /invalidPendingMcpMutation/u);
  assert.match(approvalCard, /SubagentMcpMutationApproval/u);
  assert.ok(
    approvalCard.indexOf("ref={approvalDenyRef}") <
      approvalCard.indexOf("subagentMcpMutationAllowLabel"),
    "Deny remains first and receives initial focus for mutation approvals",
  );
});

test("mounted mutation approval exposes VoiceOver relationships and starts focus on Deny", async () => {
  const release = await acquireMountedDomTest();
  const mounted = installMountedDom();
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(mounted.container);
  const details: SubagentMcpMutationApprovalDetails = {
    kind: "subagent-mcp-mutation",
    childLabel: "Publisher",
    serverId: "docs",
    toolName: "publish",
    connectionDigestPrefix: "aaaaaaaaaaaa",
    schemaDigestPrefix: "bbbbbbbbbbbb",
    profileDigestPrefix: "cccccccccccc",
    argumentDigestPrefix: "dddddddddddd",
    classification: "declared_mutating",
    destructive: "destructive",
    idempotency: "not_declared",
    openWorld: "open",
    taskSupport: "forbidden",
    timeoutMs: 30_000,
    canonicalArguments: '{"title":"Launch"}',
    priorUnknownEffect: false,
    automaticRetry: false,
    rollbackAvailable: false,
  };

  function Harness() {
    const denyRef = React.useRef<HTMLButtonElement | null>(null);
    React.useLayoutEffect(() => denyRef.current?.focus(), []);
    return (
      <section aria-labelledby="mutation-title" aria-describedby="mutation-description">
        <p id="mutation-title">Publisher wants to call docs:publish</p>
        <SubagentMcpMutationApproval details={details} descriptionId="mutation-description" />
        <button ref={denyRef} type="button">
          Deny
        </button>
        <button type="button" aria-label="Allow docs publish once">
          Allow once
        </button>
      </section>
    );
  }

  try {
    flushSync(() => root.render(<Harness />));
    const section = mounted.container.getElementsByTagName("section")[0] as HTMLElement;
    const buttons = Array.from(mounted.container.getElementsByTagName("button"));
    const argumentRegion = mounted.container.getElementsByTagName("pre")[0] as HTMLElement;
    assert.equal(section.getAttribute("aria-labelledby"), "mutation-title");
    assert.equal(section.getAttribute("aria-describedby"), "mutation-description");
    assert.equal(
      argumentRegion.getAttribute("aria-label"),
      "Complete canonical MCP mutation arguments",
    );
    assert.equal(buttons[0]?.textContent, "Deny");
    assert.equal(mounted.document.activeElement, buttons[0]);
    assert.equal(buttons[1]?.getAttribute("aria-label"), "Allow docs publish once");
  } finally {
    flushSync(() => root.unmount());
    mounted.restore();
    release();
  }
});

test("subagents reuse Aiden's activity orb states and freeze terminal motion", () => {
  const markup = renderToStaticMarkup(
    <SubagentOrb
      role="planner"
      state="running"
      activity="Reading a workspace file"
      size={64}
      className="summary-orb"
    />,
  );

  assert.equal(subagentOrbState("queued", "reviewer"), "shaping");
  assert.equal(subagentOrbState("running", "reviewer", "Searching workspace text"), "searching");
  assert.equal(subagentOrbState("running", "scout", "Reviewing workspace context"), "solving");
  assert.equal(subagentOrbState("running", "scout", "Writing a bounded report"), "composing");
  assert.equal(subagentOrbState("running", "planner"), "solving");
  assert.match(markup, /data-subagent-orb-state="active"/u);
  assert.match(markup, /data-aiden-orb-state="searching"/u);
  assert.match(markup, /summary-orb/u);
  assert.match(markup, /width:64px/u);

  const terminal = renderToStaticMarkup(
    <SubagentOrb role="reviewer" state="completed" activity="Writing a bounded report" size={20} />,
  );
  assert.match(terminal, /data-subagent-orb-state="terminal"/u);
  assert.match(terminal, /data-aiden-orb-state="composing"/u);
});

test("the roster separates active and terminal runs without color-only status", () => {
  const active = run("active");
  const done = run("done", {
    label: "Final reviewer",
    role: "reviewer",
    state: "completed",
    finishedAt: 3_000,
  });

  const activeView = view(active);
  const doneView = view(done);
  assert.deepEqual(groupSubagentRuns([doneView, activeView]), {
    active: [activeView],
    done: [doneView],
  });

  const markup = renderToStaticMarkup(
    <SubagentRoster
      runs={[doneView, activeView]}
      selectedRunId="active"
      onSelect={() => undefined}
    />,
  );
  assert.match(markup, />Active · 1</u);
  assert.match(markup, />Done · 1</u);
  assert.match(markup, /aria-label="Code scout, scout, Active"/u);
  assert.match(markup, /aria-label="Final reviewer, reviewer, Finished"/u);
  assert.match(markup, /aria-current="true"/u);

  const rosterSource = readFileSync(new URL("./subagent-roster.tsx", import.meta.url), "utf8");
  assert.match(rosterSource, /role="tree"/u);
  assert.match(rosterSource, /role="treeitem"/u);
  assert.match(rosterSource, /aria-level=\{node\.level\}/u);
  assert.match(rosterSource, /aria-posinset=\{node\.position\}/u);
  assert.match(rosterSource, /aria-setsize=\{node\.setSize\}/u);
  assert.match(rosterSource, /treeRef\.current\?\.querySelector/u);
  assert.doesNotMatch(rosterSource, /document\.querySelector/u);
});

test("the roster renders strict V2 nesting as an expanded semantic tree with roving focus", () => {
  const parent = v2Run({
    runId: "parent",
    childId: "child-parent",
    label: "Parent planner",
    role: "planner",
    state: "completed",
    finishedAt: 3_000,
  });
  const child = v2Run({
    runId: "nested",
    childId: "child-nested",
    groupId: "parent:nested-1",
    label: "Nested scout",
    parentRunId: "parent",
    depth: 2,
    state: "running",
    activity: "Inspecting nested evidence",
    finishedAt: undefined,
  });
  const markup = renderToStaticMarkup(
    <SubagentRoster
      runs={[view(parent), view(child)]}
      selectedRunId="nested"
      onSelect={() => undefined}
    />,
  );
  assert.match(markup, /role="tree"/u);
  assert.match(markup, /role="treeitem" aria-level="1"[^>]*data-subagent-treeitem="parent"/u);
  assert.match(markup, /role="treeitem" aria-level="2"[^>]*data-subagent-treeitem="nested"/u);
  assert.match(markup, /aria-expanded="true"/u);
  assert.match(markup, /role="group" aria-label="Children of Parent planner"/u);
  assert.match(markup, /Parent planner, planner, Active/u);
  assert.match(markup, /data-subagent-run-id="nested" tabindex="0"/u);
  assert.match(markup, /data-subagent-run-id="parent" tabindex="-1"/u);
});

test("depth-2 stop is node-only while depth-1 stop is explicitly cascading", () => {
  const nested = v2Run({
    runId: "nested",
    childId: "child-nested",
    parentRunId: "parent",
    depth: 2,
  });
  const rootMarkup = renderToStaticMarkup(<SubagentDetail run={v2Run()} onStop={() => undefined} />);
  const nestedMarkup = renderToStaticMarkup(<SubagentDetail run={nested} onStop={() => undefined} />);
  assert.match(rootMarkup, /aria-label="Stop subtree Code scout"/u);
  assert.match(nestedMarkup, /aria-label="Stop subagent Code scout"/u);
  assert.doesNotMatch(rootMarkup + nestedMarkup, /aria-label="Retry Code scout"/u);
});

test("mounted narrow tree keeps the selected semantic treeitem focused across live revisions", async () => {
  const releaseMountedDomTest = await acquireMountedDomTest();
  const mounted = installMountedDom();
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(mounted.container);
  const snapshots = (revision: number) => {
    const parent = v2Run({
      runId: "mounted-parent",
      childId: "child-mounted-parent",
      label: "Mounted parent",
      state: "completed",
      finishedAt: 3_000,
      revision,
    });
    const child = v2Run({
      runId: "mounted-child",
      childId: "child-mounted-child",
      groupId: "mounted-parent:nested-1",
      label: "Mounted child",
      parentRunId: "mounted-parent",
      depth: 2,
      state: "running",
      finishedAt: undefined,
      revision,
    });
    return [view(parent), view(child)];
  };
  const render = (revision: number) =>
    flushSync(() => {
      root.render(
        <SubagentsPanel
          chatId="chat-1"
          workspaceId="workspace-1"
          runs={snapshots(revision)}
          selectedRunId="mounted-child"
          compact
        />,
      );
    });

  try {
    render(1);
    const panel = Array.from(mounted.container.getElementsByTagName("div")).find(
      (element) => element.getAttribute("data-subagents-layout") === "compact",
    );
    assert.ok(panel, "compact panel mounts inside the owner focus boundary");
    const tree = Array.from(mounted.container.getElementsByTagName("div")).find(
      (element) => element.getAttribute("role") === "tree",
    );
    assert.equal(tree?.getAttribute("aria-label"), "Subagent run hierarchy");
    const treeitems = Array.from(mounted.container.getElementsByTagName("button")).filter(
      (element) => element.getAttribute("role") === "treeitem",
    ) as HTMLElement[];
    assert.equal(treeitems.length, 2);
    assert.deepEqual(treeitems.map((element) => element.getAttribute("aria-level")), ["1", "2"]);
    const child = treeitems.find(
      (element) => element.getAttribute("data-subagent-run-id") === "mounted-child",
    )!;
    assert.equal(child.getAttribute("tabindex"), "0");
    child.focus();
    render(2);
    assert.equal(
      mounted.document.activeElement?.getAttribute("data-subagent-run-id"),
      "mounted-child",
      "a live revision preserves the selected treeitem node and focus",
    );
  } finally {
    flushSync(() => root.unmount());
    await new Promise<void>((resolve) => setImmediate(resolve));
    mounted.restore();
    releaseMountedDomTest();
  }
});

test("saved detail revisits stay loading until a request succeeds or fails", () => {
  assert.equal(subagentDetailPendingLoading(true, false, true, null), true);
  assert.equal(subagentDetailPendingLoading(true, false, false, null), false);
  assert.equal(subagentDetailPendingLoading(true, false, true, "unavailable"), false);
  assert.equal(subagentDetailPendingLoading(true, true, false, null), false);
  assert.equal(subagentDetailPendingLoading(false, false, false, null), false);

  const archived = view(
    run("saved", {
      state: "completed",
      finishedAt: 3_000,
    }),
  );
  archived.snapshot = undefined;
  archived.source = "message";
  assert.deepEqual(subagentPanelSelectionState([archived], null, true, false, null), {
    runId: "saved",
    loading: true,
  });
  assert.deepEqual(subagentPanelSelectionState([archived], "saved", true, false, null), {
    runId: "saved",
    loading: false,
  });
  assert.deepEqual(subagentPanelSelectionState([archived], null, true, false, "unavailable"), {
    runId: "saved",
    loading: false,
  });
});

test("detail focus follows async replacement only while the detail region owns it", () => {
  const archived = view(
    run("saved", {
      state: "completed",
      finishedAt: 3_000,
    }),
  );
  const initialLoading = subagentDetailFocusFrame(archived, false, true, 1);
  const initialFailure = subagentDetailFocusFrame(archived, false, false, 1);
  const retryLoading = subagentDetailFocusFrame(archived, false, true, 2);
  const retryFailure = subagentDetailFocusFrame(archived, false, false, 2);
  const secondRetryLoading = subagentDetailFocusFrame(archived, false, true, 3);
  const delayedSuccess = subagentDetailFocusFrame(archived, true, false, 3);

  assert.equal(
    shouldRestoreSubagentDetailFocus(true, initialLoading, initialFailure),
    true,
    "a failed initial load replaces the focused pending detail",
  );
  assert.equal(
    shouldRestoreSubagentDetailFocus(true, initialFailure, retryLoading),
    true,
    "Retry removes its focused button when loading begins",
  );
  assert.equal(
    shouldRestoreSubagentDetailFocus(true, retryLoading, retryFailure),
    true,
    "a failed Retry keeps focus in the replacement detail",
  );
  assert.equal(
    shouldRestoreSubagentDetailFocus(true, secondRetryLoading, delayedSuccess),
    true,
    "a delayed success moves focus into the loaded replacement",
  );
  assert.equal(
    shouldRestoreSubagentDetailFocus(false, retryLoading, delayedSuccess),
    false,
    "roster focus in wide mode must not be stolen",
  );
  assert.equal(
    shouldRestoreSubagentDetailFocus(true, delayedSuccess, delayedSuccess),
    false,
    "live updates do not repeatedly refocus an unchanged loaded presentation",
  );
  assert.equal(shouldRestoreSubagentDetailFocus(true, null, initialLoading), false);
});

test("saved detail announcements cover loading, success, failure, and Retry without live duplication", () => {
  const loading = {
    ownerKey: subagentPanelOwnerKey("chat-1", "workspace-1"),
    runId: "saved",
    label: "Saved review",
    saved: true,
    presentation: "loading" as const,
  };
  const loaded = {
    ...loading,
    presentation: "loaded" as const,
    activity: "Reading a workspace file",
  };
  const unavailable = {
    ...loading,
    presentation: "unavailable" as const,
  };

  assert.equal(
    subagentDetailAnnouncement(null, loading),
    "Loading saved activity for Saved review.",
  );
  assert.equal(
    subagentDetailAnnouncement(loading, loaded),
    "Saved activity loaded for Saved review. Reading a workspace file.",
  );
  assert.equal(
    subagentDetailAnnouncement(loading, unavailable),
    "Could not load saved activity for Saved review. Retry is available.",
  );
  assert.equal(
    subagentDetailAnnouncement(unavailable, loading),
    "Retrying saved activity for Saved review.",
  );
  assert.equal(
    subagentDetailAnnouncement(loaded, {
      ...loaded,
      activity: "Writing a bounded report",
    }),
    null,
    "live activity is owned by the provider-level batched announcer",
  );
  assert.equal(
    subagentDetailAnnouncement(
      {
        ...loaded,
        saved: false,
      },
      {
        ...loaded,
        saved: true,
      },
    ),
    null,
    "an already-loaded live detail becoming saved is a silent ownership handoff, not a retry",
  );
  assert.equal(
    subagentDetailAnnouncement(loading, {
      ...loaded,
      ownerKey: subagentPanelOwnerKey("chat-2", "workspace-1"),
    }),
    null,
    "an owner change must not announce the previous chat's transition",
  );
});

test("a promoted selected detail remains loaded during persistence handoff", () => {
  const terminal = run("saved", {
    label: "Saved reviewer",
    role: "reviewer",
    revision: 7,
    state: "completed",
    activity: "Writing a bounded report",
    finishedAt: 3_000,
    updatedAt: 3_000,
  });
  const promoted = {
    ...view(terminal),
    referenceMessageId: "message-1",
  };

  assert.equal(
    subagentDetailPresentation(promoted.runId === "saved", promoted.snapshot !== undefined, false),
    "loaded",
  );
});

test("activity labels and the single live summary announce meaningful progress", () => {
  const reading = view(run("reading", { activity: "Reading a workspace file" }));
  const queued = view(
    run("queued", {
      label: "Queued review",
      state: "queued",
      activity: "Waiting for an execution slot",
    }),
  );

  assert.equal(
    subagentStatusLabel("running", reading.snapshot?.activity),
    "Reading a workspace file",
  );
  assert.equal(subagentStatusLabel("queued", queued.snapshot?.activity), "Queued");
  assert.equal(
    subagentLiveSummary([reading, queued]),
    "2 active subagents; 0 done. Queued review: Queued; Code scout: Reading a workspace file.",
  );
  assert.equal(
    subagentSnapshotLiveSummary([reading.snapshot!, queued.snapshot!]),
    "2 active subagents; 0 done. Code scout: Reading a workspace file; Queued review: Queued.",
  );
  assert.equal(subagentSnapshotLiveSummaryIsTerminal([reading.snapshot!, queued.snapshot!]), false);
  assert.equal(
    subagentSnapshotLiveSummaryIsTerminal([run("done", { state: "completed", finishedAt: 3_000 })]),
    true,
  );
});

test("terminal live summaries name success, failure, timeout, interruption, and mixed outcomes", () => {
  const completed = run("completed", {
    label: "Private successful task",
    state: "completed",
    finishedAt: 3_000,
  });
  const failed = run("failed", {
    label: "Private failed task",
    state: "failed",
    error: "This error must not reach the live region.",
    finishedAt: 3_000,
  });
  const timedOut = run("timed-out", {
    state: "timed_out",
    finishedAt: 3_000,
  });
  const interrupted = run("interrupted", {
    state: "interrupted",
    finishedAt: 3_000,
  });

  assert.equal(
    subagentSnapshotLiveSummary([completed]),
    "0 active subagents; 1 completed successfully.",
  );
  assert.equal(subagentSnapshotLiveSummary([failed]), "0 active subagents; 1 failed.");
  assert.equal(subagentSnapshotLiveSummary([timedOut]), "0 active subagents; 1 timed out.");
  assert.equal(subagentSnapshotLiveSummary([interrupted]), "0 active subagents; 1 interrupted.");
  const mixed = subagentSnapshotLiveSummary([completed, failed, timedOut, interrupted]);
  assert.equal(
    mixed,
    "0 active subagents; 1 completed successfully; 1 failed; 1 timed out; 1 interrupted.",
  );
  assert.equal(subagentLiveSummary([view(failed)]), "0 active subagents; 1 failed.");
  assert.equal(
    subagentSnapshotLiveSummaryIsTerminal([completed, failed, timedOut, interrupted]),
    true,
  );
  assert.doesNotMatch(mixed, /\bdone\b/u);
  assert.doesNotMatch(mixed, /Private|error|Users/u);
});

test("terminal activity flushes when the same owner clears before the live debounce", () => {
  const tasks = new Map<number, () => void>();
  const published: string[] = [];
  let timerId = 0;
  const coordinator = new SubagentLiveAnnouncementCoordinator(
    (announcement) => published.push(announcement),
    (callback) => {
      const id = ++timerId;
      tasks.set(id, callback);
      return id;
    },
    (timer) => tasks.delete(timer as number),
  );
  const terminalSummary = "0 active subagents; 1 completed successfully.";

  coordinator.update("chat-1", terminalSummary, true);
  assert.deepEqual(published, []);
  assert.equal(tasks.size, 1);

  coordinator.update("chat-1", "", false);
  assert.deepEqual(published, [terminalSummary]);
  assert.equal(tasks.size, 0, "the canceled timer must not announce the terminal sentence twice");
  coordinator.dispose();
});

test("owner changes suppress pending terminal activity and debounce only the new owner", () => {
  const tasks = new Map<number, () => void>();
  const published: string[] = [];
  let timerId = 0;
  const coordinator = new SubagentLiveAnnouncementCoordinator(
    (announcement) => published.push(announcement),
    (callback) => {
      const id = ++timerId;
      tasks.set(id, callback);
      return id;
    },
    (timer) => tasks.delete(timer as number),
  );
  const staleTerminalSummary = "0 active subagents; 1 completed successfully.";
  const newOwnerSummary = "1 active subagent; 0 done. New scout: Working.";

  coordinator.update("chat-1", staleTerminalSummary, true);
  coordinator.update("chat-2", newOwnerSummary, false);
  assert.deepEqual(published, [""], "owner change clears the previous owner's live region");
  assert.equal(tasks.size, 1, "only the new owner's debounce remains");

  for (const callback of tasks.values()) callback();
  assert.deepEqual(published, ["", newOwnerSummary]);
  assert.doesNotMatch(published.join(" "), /1 done/u);
  coordinator.dispose();
});

test("an A terminal snapshot cannot be reassigned or announced after navigating to empty B", () => {
  const tasks = new Map<number, () => void>();
  const published: string[] = [];
  let timerId = 0;
  const coordinator = new SubagentLiveAnnouncementCoordinator(
    (announcement) => published.push(announcement),
    (callback) => {
      const id = ++timerId;
      tasks.set(id, callback);
      return id;
    },
    (timer) => tasks.delete(timer as number),
  );
  const terminalA = run("done-a", {
    chatId: "chat-a",
    workspaceId: "workspace-1",
    state: "completed",
    finishedAt: 3_000,
  });

  coordinator.update(
    subagentPanelOwnerKey("chat-a", "workspace-1"),
    subagentSnapshotLiveSummary([terminalA]),
    true,
  );
  const bSnapshots = mergeSubagentSnapshots([], [terminalA], {
    chatId: "chat-b",
    workspaceId: "workspace-1",
  });
  assert.deepEqual(bSnapshots, [], "the provider ingestion boundary must reject A's snapshot");
  coordinator.update(
    subagentPanelOwnerKey("chat-b", "workspace-1"),
    bSnapshots.length > 0 ? subagentSnapshotLiveSummary(bSnapshots) : "",
    subagentSnapshotLiveSummaryIsTerminal(bSnapshots),
  );

  assert.deepEqual(published, [""], "navigation clears the region without announcing A as B");
  assert.equal(tasks.size, 0);
  assert.doesNotMatch(published.join(" "), /1 done/u);
  coordinator.dispose();
});

test("saved-detail lifecycle shares the coordinator without being overwritten by live activity", () => {
  const tasks = new Map<number, () => void>();
  const published: string[] = [];
  let timerId = 0;
  const coordinator = new SubagentLiveAnnouncementCoordinator(
    (announcement) => published.push(announcement),
    (callback) => {
      const id = ++timerId;
      tasks.set(id, callback);
      return id;
    },
    (timer) => tasks.delete(timer as number),
  );
  const owner = subagentPanelOwnerKey("chat-1", "workspace-1");
  const runNext = () => {
    const entry = tasks.entries().next().value as [number, () => void] | undefined;
    assert.ok(entry, "expected a queued shared announcement");
    tasks.delete(entry[0]);
    entry[1]();
  };

  coordinator.update(owner, "1 active subagent; 0 done. Scout: Reading.", false);
  coordinator.announceDetail(owner, "Loading saved activity for Saved review.");
  coordinator.update(owner, "1 active subagent; 0 done. Scout: Writing.", false);
  assert.equal(tasks.size, 1, "detail and live activity use one serialized debounce");

  runNext();
  assert.deepEqual(published, ["Loading saved activity for Saved review."]);
  assert.equal(tasks.size, 1, "the latest live summary remains queued after the detail message");
  runNext();
  assert.deepEqual(published, [
    "Loading saved activity for Saved review.",
    "1 active subagent; 0 done. Scout: Writing.",
  ]);

  coordinator.announceDetail(owner, "Retrying saved activity for Saved review.");
  coordinator.update(subagentPanelOwnerKey("chat-2", "workspace-1"), "", false);
  assert.equal(tasks.size, 0, "an owner change discards the old detail lifecycle message");
  assert.equal(published[published.length - 1], "");
  coordinator.dispose();
});

test("live-to-persisted chip focus waits by run ID and never overrides moved focus", () => {
  const inside = {} as Node;
  let focused = "";
  const chip = (runId: string, isConnected: boolean): SubagentChipFocusTarget => ({
    dataset: { subagentChipRunId: runId },
    isConnected,
    contains: (target) => target === inside,
    focus: () => {
      focused = runId;
    },
  });
  const oldLiveChip = chip("run-1", true);
  const replacementChip = chip("run-1", true);
  const capture = captureSubagentChipFocus(oldLiveChip);
  const body = {};
  const documentElement = {};

  assert.deepEqual(
    resolveSubagentChipFocusHandoff(
      capture,
      oldLiveChip,
      [body, documentElement],
      [replacementChip],
    ),
    { action: "retain" },
    "a still-connected live chip keeps its own focus",
  );
  assert.equal(retainSubagentChipFocusAfterPointerDown(capture, inside), capture);
  assert.equal(retainSubagentChipFocusAfterPointerDown(capture, {} as Node), null);

  oldLiveChip.isConnected = false;
  assert.deepEqual(
    resolveSubagentChipFocusHandoff(capture, body, [body, documentElement], []),
    { action: "retain" },
    "identity survives the render gap before persistence mounts a replacement",
  );
  const handoff = resolveSubagentChipFocusHandoff(
    capture,
    body,
    [body, documentElement],
    [chip("other", true), replacementChip],
  );
  assert.equal(handoff.action, "focus");
  if (handoff.action === "focus") handoff.target.focus({ preventScroll: true });
  assert.equal(focused, "run-1");

  assert.deepEqual(
    resolveSubagentChipFocusHandoff(
      capture,
      { moved: true },
      [body, documentElement],
      [replacementChip],
    ),
    { action: "clear" },
    "a connected destination chosen by the user always wins",
  );
});

test("detail growth follows untouched live updates and preserves user navigation", () => {
  const previous = { runId: "run-1", revision: 1 };
  assert.equal(
    subagentDetailGrowthAction(previous, { runId: "run-1", revision: 2 }, false),
    "follow",
  );
  assert.equal(
    subagentDetailGrowthAction(previous, { runId: "run-1", revision: 2 }, true),
    "measure",
  );
  assert.equal(
    subagentDetailGrowthAction(previous, { runId: "run-2", revision: 1 }, false),
    "reset",
  );
  assert.equal(subagentDetailIsAwayFromLatest(1_000, 400, 200), true);
  assert.equal(subagentDetailIsAwayFromLatest(1_000, 400, 560), false);
});

test("compact Back restores the externally selected roster row", () => {
  let focused = "";
  const buttons = [
    { dataset: { subagentRunId: "first" }, focus: () => (focused = "first") },
    {
      dataset: { subagentRunId: "selected" },
      focus: () => (focused = "selected"),
    },
  ];

  assert.equal(subagentDetailRestoreRunId({ runId: "selected" }), "selected");
  assert.equal(focusSubagentRosterRun(buttons, "selected"), true);
  assert.equal(focused, "selected");
  assert.equal(focusSubagentRosterRun(buttons, "missing"), false);
});

test("breakpoint changes restore detail and Back focus to deterministic semantic targets", () => {
  assert.equal(subagentPanelBreakpointFocusTarget(false, true, "detail"), "detail");
  assert.equal(subagentPanelBreakpointFocusTarget(true, false, "detail"), "detail");
  assert.equal(subagentPanelBreakpointFocusTarget(true, false, "back"), "roster");
  assert.equal(subagentPanelBreakpointFocusTarget(false, true, "roster"), "roster");
  assert.equal(subagentPanelBreakpointFocusTarget(false, false, "detail"), null);
  assert.equal(subagentPanelBreakpointFocusTarget(false, true, null), null);
});

test("mounted compact selection repair restores Back and breakpoint focus to the surviving row", async () => {
  const releaseMountedDomTest = await acquireMountedDomTest();
  const mounted = installMountedDom();
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(mounted.container);
  const renderHarness = (
    runIds: readonly string[],
    compact: boolean,
    compactView: "detail" | "roster",
    focusedSurface: "back" | "detail",
  ) => {
    flushSync(() => {
      root.render(
        <MountedSelectionRepairHarness
          runIds={runIds}
          requestedRunId="A"
          compact={compact}
          compactView={compactView}
          focusedSurface={focusedSurface}
        />,
      );
    });
  };

  try {
    renderHarness(["A", "B"], true, "detail", "detail");
    const detail = mounted.container.querySelector("[data-subagent-detail-heading]") as HTMLElement;
    detail.focus();

    renderHarness(["B"], true, "detail", "detail");
    assert.notEqual(
      mounted.document.activeElement?.getAttribute("data-subagent-run-id"),
      "B",
      "repairing selection alone does not move focus into the hidden roster",
    );
    renderHarness(["B"], true, "roster", "detail");
    assert.equal(
      mounted.document.activeElement?.getAttribute("data-subagent-run-id"),
      "B",
      "Back focuses the repaired surviving row",
    );

    renderHarness(["A", "B"], true, "detail", "back");
    const back = Array.from(mounted.container.getElementsByTagName("button")).find((button) =>
      button.hasAttribute("data-subagent-back"),
    ) as HTMLElement;
    back.focus();
    renderHarness(["B"], false, "detail", "back");
    assert.equal(
      mounted.document.activeElement?.getAttribute("data-subagent-run-id"),
      "B",
      "a compact-to-wide breakpoint restores the repaired roster row",
    );

    renderHarness(["A", "B"], true, "detail", "detail");
    mounted.outside.focus();
    renderHarness(["B"], true, "detail", "detail");
    assert.equal(
      mounted.document.activeElement,
      mounted.outside,
      "selection repair never steals focus from outside Subagents",
    );
  } finally {
    flushSync(() => root.unmount());
    await new Promise<void>((resolve) => setImmediate(resolve));
    mounted.restore();
    releaseMountedDomTest();
  }
});

test("mounted compact Environment trap keeps a pointer-focused disclosure in Tab order without Jump to latest", async () => {
  const releaseMountedDomTest = await acquireMountedDomTest();
  const mounted = installMountedDom();
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(mounted.container);

  try {
    flushSync(() => {
      root.render(
        <aside role="dialog" aria-modal="true" data-environment-compact-modal="true">
          <button type="button">Close Environment</button>
          <button type="button" data-subagent-run-id="selected">
            Selected subagent
          </button>
          <input aria-label="Filter subagents" />
          <details>
            <summary data-subagent-milestones="true">3 tool uses · 2 activity milestones</summary>
          </details>
          <button type="button">Next detail control</button>
        </aside>,
      );
    });

    const surface = mounted.container.getElementsByTagName("aside")[0] as HTMLElement;
    const buttons = Array.from(surface.getElementsByTagName("button")) as HTMLElement[];
    const input = surface.getElementsByTagName("input")[0] as HTMLElement;
    const summary = surface.getElementsByTagName("summary")[0] as HTMLElement;
    const focusableCandidates = [buttons[0]!, buttons[1]!, input, summary, buttons[2]!];
    for (const element of focusableCandidates) {
      Object.defineProperty(element, "offsetParent", {
        configurable: true,
        value: surface,
      });
      Object.defineProperty(element, "closest", {
        configurable: true,
        value: () => null,
      });
    }
    let receivedSelector = "";
    Object.defineProperty(surface, "querySelectorAll", {
      configurable: true,
      value: (selector: string) => {
        receivedSelector = selector;
        return focusableCandidates;
      },
    });

    summary.focus();
    const focusable = environmentCompactModalFocusableTargets(surface);
    assert.equal(receivedSelector, ENVIRONMENT_COMPACT_MODAL_FOCUSABLE_SELECTOR);
    assert.ok(
      ENVIRONMENT_COMPACT_MODAL_FOCUSABLE_SELECTOR.includes("summary:not([tabindex='-1'])"),
    );
    assert.ok(focusable.includes(buttons[0]!));
    assert.ok(focusable.includes(buttons[1]!));
    assert.ok(focusable.includes(input));
    assert.ok(focusable.includes(summary));
    assert.equal(mounted.document.activeElement, summary, "the disclosure has pointer focus");
    assert.equal(
      environmentCompactModalTabWrapTarget(focusable, summary, false),
      null,
      "Tab from the disclosure keeps native order instead of wrapping to the modal start",
    );
    assert.equal(
      environmentCompactModalTabWrapTarget(focusable, buttons[2]!, false),
      buttons[0],
      "the last control still wraps to the modal start",
    );
    assert.equal(
      environmentCompactModalTabWrapTarget(focusable, buttons[0]!, true),
      buttons[2],
      "Shift+Tab from the first control still wraps to the modal end",
    );
    assert.equal(
      mountedElementsWithAttribute(mounted.document, "data-subagent-jump-latest").length,
      0,
      "the regression does not rely on the conditional Jump to latest control",
    );
  } finally {
    flushSync(() => root.unmount());
    await new Promise<void>((resolve) => setImmediate(resolve));
    mounted.restore();
    releaseMountedDomTest();
  }
});

test("mounted live announcer stays singular and active in compact and inline surfaces", async () => {
  const releaseMountedDomTest = await acquireMountedDomTest();
  const mounted = installMountedDom();
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(mounted.container);
  const host = mounted.document.createElement("aside");
  mounted.document.body.appendChild(host);
  const terminalRun = run("done", {
    state: "completed",
    activity: "Review complete",
    finishedAt: 3_000,
  });
  const renderHarness = (
    compactModal: boolean,
    detailRequest: SubagentDetailAnnouncementRequest | null,
  ) => {
    if (compactModal) {
      host.setAttribute("role", "dialog");
      host.setAttribute("aria-modal", "true");
      host.removeAttribute("data-environment-inline");
    } else {
      host.removeAttribute("role");
      host.removeAttribute("aria-modal");
      host.setAttribute("data-environment-inline", "true");
    }
    flushSync(() => {
      root.render(
        <MountedLiveAnnouncerHarness
          detailRequest={detailRequest}
          host={host as unknown as HTMLElement}
          runs={[terminalRun]}
        />,
      );
    });
  };

  try {
    renderHarness(true, null);
    await new Promise((resolve) => setTimeout(resolve, 150));
    flushSync(() => undefined);
    let regions = mountedElementsWithAttribute(mounted.document, "data-subagent-live-announcer");
    assert.equal(regions.length, 1);
    let ancestor: HTMLElement | null = regions[0];
    let modalAncestor: HTMLElement | null = null;
    while (ancestor) {
      assert.notEqual(ancestor.getAttribute("aria-hidden"), "true");
      assert.equal(ancestor.hasAttribute("inert"), false);
      if (ancestor.getAttribute("role") === "dialog") modalAncestor = ancestor;
      ancestor = ancestor.parentNode instanceof HTMLElement ? ancestor.parentNode : null;
    }
    assert.ok(modalAncestor, "the sole compact region is inside the active modal subtree");
    assert.match(regions[0].textContent ?? "", /0 active subagents; 1 completed successfully\./u);

    renderHarness(true, {
      id: 1,
      ownerKey: subagentPanelOwnerKey("chat-1", "workspace-1"),
      message: "Saved activity loaded for Code scout. Review complete.",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    flushSync(() => undefined);
    regions = mountedElementsWithAttribute(mounted.document, "data-subagent-live-announcer");
    assert.equal(regions.length, 1);
    assert.equal(regions[0].textContent, "Saved activity loaded for Code scout. Review complete.");

    renderHarness(false, {
      id: 2,
      ownerKey: subagentPanelOwnerKey("chat-1", "workspace-1"),
      message: "Loading saved activity for Code scout.",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    flushSync(() => undefined);
    regions = mountedElementsWithAttribute(mounted.document, "data-subagent-live-announcer");
    assert.equal(regions.length, 1);
    assert.ok(
      regions[0].parentNode instanceof HTMLElement &&
        regions[0].parentNode.hasAttribute("data-environment-inline"),
      "the same region moves into the active inline Environment subtree",
    );
    assert.equal(regions[0].textContent, "Loading saved activity for Code scout.");
  } finally {
    flushSync(() => root.unmount());
    await new Promise<void>((resolve) => setImmediate(resolve));
    mounted.restore();
    releaseMountedDomTest();
  }
});

test("mounted owner replacement recovers focused detail without stealing outside focus", async () => {
  const releaseMountedDomTest = await acquireMountedDomTest();
  const mounted = installMountedDom();
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(mounted.container);
  const renderOwner = (
    ownerKey: string,
    destination: "compact" | "empty" | "fallback" | "wide",
  ) => {
    flushSync(() => {
      root.render(
        <SubagentOwnerFocusBoundary
          ownerKey={ownerKey}
          replacementKey={ownerKey}
          active
          fallbackFocusTarget={() => mounted.outside}
        >
          <div key={ownerKey}>
            {destination === "empty" ? (
              <h2 tabIndex={-1} data-subagent-empty-heading="true">
                No subagents yet
              </h2>
            ) : destination === "compact" ? (
              <button type="button" data-subagent-run-id="compact-run" aria-current="true">
                Compact run
              </button>
            ) : destination === "wide" ? (
              <>
                <button type="button" data-subagent-run-id="wide-run" aria-current="true">
                  Wide run
                </button>
                <h2 tabIndex={-1} data-subagent-detail-heading="true">
                  Wide detail
                </h2>
              </>
            ) : null}
          </div>
        </SubagentOwnerFocusBoundary>,
      );
    });
  };

  try {
    renderOwner("chat-a", "wide");
    const outgoingDetail = mounted.container.querySelector(
      "[data-subagent-detail-heading]",
    ) as HTMLElement;
    outgoingDetail.focus();

    renderOwner("chat-b", "empty");
    assert.equal(
      mounted.document.activeElement?.textContent,
      "No subagents yet",
      "an empty next owner receives focus before paint instead of leaving it on body",
    );

    renderOwner("chat-c", "wide");
    assert.equal(
      mounted.document.activeElement?.textContent,
      "Wide detail",
      "wide replacement keeps the semantic detail destination",
    );

    mounted.outside.focus();
    renderOwner("chat-d", "empty");
    assert.equal(
      mounted.document.activeElement,
      mounted.outside,
      "owner replacement must not steal focus that was outside Subagents",
    );

    const emptyHeading = mounted.container.querySelector(
      "[data-subagent-empty-heading]",
    ) as HTMLElement;
    emptyHeading.focus();
    renderOwner("chat-e", "compact");
    assert.equal(
      mounted.document.activeElement?.getAttribute("data-subagent-run-id"),
      "compact-run",
      "compact replacement restores to the selected roster row",
    );

    renderOwner("chat-f", "fallback");
    assert.equal(
      mounted.document.activeElement,
      mounted.outside,
      "the active Subagents tab fallback remains available when no internal target mounts",
    );
  } finally {
    flushSync(() => root.unmount());
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    mounted.restore();
    releaseMountedDomTest();
  }
});

test("chat and workspace jointly own compact navigation state", () => {
  assert.equal(
    subagentPanelOwnerKey("chat-1", "workspace-1"),
    subagentPanelOwnerKey("chat-1", "workspace-1"),
  );
  assert.notEqual(
    subagentPanelOwnerKey("chat-1", "workspace-1"),
    subagentPanelOwnerKey("chat-2", "workspace-1"),
  );
  assert.notEqual(
    subagentPanelOwnerKey("chat-1", "workspace-1"),
    subagentPanelOwnerKey("chat-1", "workspace-2"),
  );
});

test("detail and panel preserve bounded rendering and navigation contracts", () => {
  const detailSource = readFileSync(new URL("./subagent-detail.tsx", import.meta.url), "utf8");
  const panelSource = readFileSync(new URL("./subagents-panel.tsx", import.meta.url), "utf8");

  assert.match(detailSource, /<details className=/u);
  assert.doesNotMatch(detailSource, /<details[^>]*\bopen=/u);
  assert.match(detailSource, /<ErrorBoundary/u);
  assert.match(detailSource, /<Markdown content=\{run\.terminalMarkdown\}/u);
  assert.match(detailSource, /\{awayFromLatest \? \(/u);
  assert.match(detailSource, /data-subagent-jump-latest="true"/u);
  assert.match(detailSource, /onPointerDownCapture=\{markUserNavigation\}/u);
  assert.doesNotMatch(detailSource, /event\.target === event\.currentTarget/u);
  assert.match(detailSource, /dataset\.reduceMotion === "true"/u);
  assert.match(detailSource, /data-subagent-detail-heading="true"/u);
  assert.match(detailSource, /subagentMilestoneAggregate\(run\)/u);
  assert.match(detailSource, /run\.milestones\.map/u);
  assert.match(detailSource, /Model:/u);
  assert.match(detailSource, /run\.modelId/u);
  assert.match(detailSource, /Tool arguments, results, commands, and paths stay/u);

  assert.match(panelSource, /chatId: string \| null/u);
  assert.match(panelSource, /workspaceId: string \| null/u);
  assert.match(panelSource, /selectedRunSnapshot\?: SubagentRunSnapshot \| null/u);
  assert.match(panelSource, /detailLoading\?: boolean/u);
  assert.match(panelSource, /detailError\?: string \| null/u);
  assert.match(panelSource, /onRetryDetail\?: \(runId: string\) => void/u);
  assert.match(panelSource, /onStopRun\?: \(run: SubagentRunSnapshot\)/u);
  assert.doesNotMatch(panelSource, /onRetryRun\?: \(run: SubagentRunSnapshot\)/u);
  assert.match(
    panelSource,
    /onDetailAnnouncement\?: \(ownerKey: string, message: string\) => void/u,
  );
  assert.match(panelSource, /detailRequestVersion\?: number/u);
  assert.match(panelSource, /active\?: boolean/u);
  assert.match(panelSource, /matchingDetailSnapshot/u);
  assert.match(panelSource, /Loading subagent activity…/u);
  assert.match(panelSource, /data-subagent-detail-unavailable="true"/u);
  assert.match(panelSource, /aria-label=\{`Retry loading details for \$\{run\.label\}`\}/u);
  assert.match(panelSource, /\sRetry\s*<\/Button>/u);
  assert.match(panelSource, /data-subagent-detail-heading="true"/u);
  assert.match(panelSource, /data-subagent-detail-region="true"/u);
  assert.match(panelSource, /onFocusCapture=/u);
  assert.match(panelSource, /onBlurCapture=/u);
  assert.match(panelSource, /shouldRestoreSubagentDetailFocus/u);
  assert.doesNotMatch(panelSource, /\{detailError\}/u);
  assert.doesNotMatch(panelSource, /aria-live=/u);
  assert.doesNotMatch(panelSource, /role="status"/u);
  assert.doesNotMatch(panelSource, /data-subagent-detail-announcer/u);
  assert.match(panelSource, /onDetailAnnouncement\?\.\(ownerKey, message\)/u);
  assert.match(panelSource, /subagentPanelBreakpointFocusTarget/u);
  assert.match(panelSource, /data-subagent-back="true"/u);
  assert.match(panelSource, /if \(!active \|\| !hasActiveRuns\) return/u);
  assert.doesNotMatch(panelSource, /loadingObservedRunIdRef/u);
  assert.match(
    panelSource,
    /subagentDetailPendingLoading\(\s*selectedRun !== null,\s*detailSnapshot !== null,\s*detailLoading,\s*detailError/u,
  );
  assert.match(panelSource, /if \(compact\) setCompactView\("detail"\)/u);
  assert.match(panelSource, /useRef\(detailRequestVersion\)/u);
  assert.match(panelSource, /<SubagentOwnerFocusBoundary/u);
  assert.match(panelSource, /<OwnedSubagentsPanel key=\{ownerKey\}/u);
  assert.match(panelSource, /data-subagent-empty-heading="true"/u);
  assert.match(panelSource, /ownerReplacementFallbackFocusTarget\?: \(\) => HTMLElement \| null/u);
  assert.doesNotMatch(panelSource, /initialCompactView/u);
  assert.match(
    panelSource,
    /restoreRunIdRef\.current = subagentDetailRestoreRunId\(selectedRun\)/u,
  );
  assert.match(panelSource, /useSubagentSelectionRestoreRunRepair\(/u);
  assert.match(
    panelSource,
    /focusSubagentRosterRun\(buttons \?\? \[\], restoreRunIdRef\.current\)/u,
  );
  assert.match(panelSource, /Back to subagents/u);
});
