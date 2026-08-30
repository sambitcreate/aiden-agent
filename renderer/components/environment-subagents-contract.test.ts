import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DISABLED_APP_CAPABILITIES, parseAppCapabilities } from "../lib/app-capabilities.js";
import {
  availableEnvironmentPanelTabs,
  focusEnvironmentCompactModalTransition,
  normalizeEnvironmentPanelTab,
  storedEnvironmentPanelTab,
  type EnvironmentFocusBoundary,
  type EnvironmentFocusTarget,
} from "../lib/environment-panel-state.js";
import {
  compactSidebarAutoFocusIntent,
  type CompactSidebarFocusState,
} from "../lib/compact-sidebar-focus.js";
import {
  EMPTY_SUBAGENT_STOP_PENDING_STATE,
  beginSubagentStopPending,
  clearSubagentStopPending,
  failSubagentStopPending,
  replaceSubagentStopPendingOwner,
} from "../lib/subagent-stop-pending.js";
import { visibleSubagentReferences } from "../lib/subagent-feature-gate.js";
import type { ChatMessage } from "../lib/types.js";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function between(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing ${start}`);
  assert.notEqual(endIndex, -1, `Missing ${end}`);
  return value.slice(startIndex, endIndex);
}

test("fresh renderer capabilities fail closed until main explicitly enables features", () => {
  assert.deepEqual(parseAppCapabilities(undefined), DISABLED_APP_CAPABILITIES);
  assert.deepEqual(parseAppCapabilities({ subagents: "1", platform: "plan9" }), {
    ...DISABLED_APP_CAPABILITIES,
  });
  assert.deepEqual(parseAppCapabilities({ subagents: true, platform: "linux" }), {
    ...DISABLED_APP_CAPABILITIES,
    platform: "linux",
    subagents: true,
  });
  assert.equal(parseAppCapabilities({ bots: true }).bots, true);
  assert.deepEqual(availableEnvironmentPanelTabs(false), ["review", "files"]);
  assert.deepEqual(availableEnvironmentPanelTabs(true), ["review", "subagents", "files"]);
});

test("a disabled renderer repairs a stored Subagents destination to Overview", () => {
  const values = new Map<string, string>([["tab", "subagents"]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.equal(storedEnvironmentPanelTab(storage, "tab", false), "overview");
  assert.equal(values.get("tab"), "overview");
  assert.equal(normalizeEnvironmentPanelTab("subagents", false), "overview");
  assert.equal(normalizeEnvironmentPanelTab("subagents", true), "subagents");
});

test("an already-open inline surface moves outside focus into its compact modal before paint", () => {
  const inside = {} as Node;
  const outside = {} as Node;
  let surfaceFocusCount = 0;
  let tabFocusCount = 0;
  const surface: EnvironmentFocusBoundary = {
    isConnected: true,
    contains: (target) => target === inside,
    focus: () => {
      surfaceFocusCount += 1;
    },
  };
  const activeTab: EnvironmentFocusTarget = {
    isConnected: true,
    focus: () => {
      tabFocusCount += 1;
    },
  };
  const inline = { fullOpen: true, compactModal: false };
  const modal = { fullOpen: true, compactModal: true };

  assert.equal(
    focusEnvironmentCompactModalTransition(inline, modal, surface, outside, activeTab),
    true,
  );
  assert.equal(tabFocusCount, 1);
  assert.equal(surfaceFocusCount, 0);

  assert.equal(
    focusEnvironmentCompactModalTransition(inline, modal, surface, inside, activeTab),
    false,
    "focus already inside the surface must not be stolen",
  );
  assert.equal(
    focusEnvironmentCompactModalTransition(
      { fullOpen: false, compactModal: false },
      modal,
      surface,
      outside,
      activeTab,
    ),
    false,
    "initial compact open keeps the existing initial-open focus path",
  );
  assert.equal(
    focusEnvironmentCompactModalTransition(modal, modal, surface, outside, activeTab),
    false,
    "ordinary compact rerenders must not refocus the modal",
  );

  activeTab.isConnected = false;
  assert.equal(
    focusEnvironmentCompactModalTransition(inline, modal, surface, outside, activeTab),
    true,
  );
  assert.equal(surfaceFocusCount, 1, "the mounted dialog is the safe fallback");
});

test("compact sidebar remount defers to Environment's exact multi-frame focus restoration", () => {
  const sidebarOpen: CompactSidebarFocusState = {
    compact: true,
    expanded: true,
    contentModalOpen: false,
  };
  const environmentOpen = { ...sidebarOpen, contentModalOpen: true };
  const environmentClosed = { ...sidebarOpen };
  const firstSidebarControl = { id: "new-agent" };
  const exactReturnTarget = { id: "selected-chat" };
  let activeElement = { id: "environment-close" };
  let frames: Array<() => void> = [];
  const requestFrame = (callback: () => void) => frames.push(callback);
  const flushFrame = () => {
    const current = frames;
    frames = [];
    current.forEach((callback) => callback());
  };

  assert.equal(compactSidebarAutoFocusIntent(sidebarOpen, environmentOpen), null);
  requestFrame(() => {
    activeElement = exactReturnTarget;
  });
  flushFrame();
  assert.equal(activeElement, exactReturnTarget);

  const resumedIntent = compactSidebarAutoFocusIntent(environmentOpen, environmentClosed);
  if (resumedIntent === "first-control") {
    requestFrame(() => {
      activeElement = firstSidebarControl;
    });
  }
  flushFrame();

  assert.equal(resumedIntent, "preserve-current");
  assert.equal(activeElement, exactReturnTarget);
  assert.equal(frames.length, 0, "the resumed trap must not leave a later focus frame queued");
});

test("ordinary compact sidebar opens still auto-focus their first control", () => {
  const collapsed: CompactSidebarFocusState = {
    compact: true,
    expanded: false,
    contentModalOpen: false,
  };
  const opened = { ...collapsed, expanded: true };

  assert.equal(compactSidebarAutoFocusIntent(collapsed, opened), "first-control");
  assert.equal(compactSidebarAutoFocusIntent(opened, opened), null);
});

test("compact Environment modality blocks every app-level interaction seam and cleans up", () => {
  const environment = source("./environment-panel.tsx");
  const root = source("../main/root-view.tsx");
  const layout = source("../main/chat-layout.tsx");
  const splitView = source("./ui.tsx");
  const assistant = source("./assistant/assistant-dock.tsx");
  const commands = source("../lib/command-system.tsx");

  assert.match(environment, /const overlayOpen = fullOpen && !inline/u);
  assert.match(environment, /setCompactModalOpen\(overlayOpen\)/u);
  assert.match(environment, /environmentCompactModalFocusableTargets\(surfaceRef\.current\)/u);
  assert.match(
    environment,
    /environmentCompactModalTabWrapTarget\([\s\S]*document\.activeElement,[\s\S]*event\.shiftKey/u,
  );
  assert.match(
    environment,
    /return \(\) => \{\s*setCompactModalOpen\(false\);\s*\}/u,
    "close, responsive-inline transitions, and route unmount must clear shared modal state",
  );
  assert.doesNotMatch(environment, /\.closest\("main"\)/u);
  assert.doesNotMatch(environment, /const snapshots = background\.map/u);

  assert.match(root, /<CommandSystemProvider applicationModal=\{compactModalOpen\}>/u);
  assert.match(
    root,
    /<AssistantDock interactionBlocked=\{environmentPanel\.compactModalOpen\} \/>/u,
  );
  assert.match(layout, /contentModalOpen=\{environmentPanel\.compactModalOpen\}/u);
  assert.match(splitView, /inert=\{collapsed \|\| contentModalOpen \? true : undefined\}/u);
  assert.match(splitView, /tabIndex=\{collapsed \|\| compact \|\| contentModalOpen \? -1 : 0\}/u);
  assert.match(splitView, /useCommandHandler\("sidebar\.toggle", toggle, !contentModalOpen\)/u);
  assert.match(
    splitView,
    /compactSidebarFocusIntentRef\.current = compactSidebarAutoFocusIntent\(\s*previousCompactSidebarFocusStateRef\.current,\s*next,\s*\)/u,
  );
  assert.match(
    splitView,
    /compactSidebarFocusIntentRef\.current === "first-control"\s*\?\s*requestAnimationFrame/u,
  );

  assert.match(assistant, /if \(interactionBlocked\) return/u);
  assert.match(
    assistant,
    /useCommandHandler\("assistant\.open", openPanel, !interactionBlocked\)/u,
  );
  assert.match(assistant, /inert=\{interactionBlocked \? true : undefined\}/u);
  assert.match(assistant, /aria-hidden=\{interactionBlocked \? true : undefined\}/u);
  assert.match(assistant, /visibility: interactionBlocked \? "hidden" : undefined/u);

  assert.match(commands, /commandExecutionAllowed\(commandId, \{\s*applicationModal/u);
  assert.match(commands, /if \(applicationModal && paletteOpen\) setPaletteOpen\(false\)/u);
});

test("archived subagent references remain stored but are invisible while disabled", () => {
  const messages: ChatMessage[] = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "Saved response",
      createdAt: 1,
      subagents: {
        version: 1,
        generationId: "generation-1",
        runIds: ["run-1"],
        items: [
          {
            runId: "run-1",
            label: "Saved reviewer",
            role: "reviewer",
            state: "completed",
          },
        ],
        total: 1,
        completed: 1,
        failed: 0,
        timedOut: 0,
        interrupted: 0,
      },
    },
  ];

  assert.deepEqual(visibleSubagentReferences(messages, false), []);
  assert.equal(messages[0]?.subagents?.runIds[0], "run-1");
  assert.equal(visibleSubagentReferences(messages, true).length, 1);
});

test("the Environment work surface owns one mounted Subagents destination", () => {
  const environment = source("./environment-panel.tsx");

  assert.match(environment, /availableEnvironmentPanelTabs\(panel\.subagentsEnabled\)/u);
  assert.match(environment, /\{panel\.subagentsEnabled \? \(\s*<div/u);
  assert.match(environment, /id="environment-subagents-panel"/u);
  assert.match(environment, /hidden=\{panel\.tab !== "subagents"\}/u);
  assert.match(environment, /active=\{panel\.open && panel\.tab === "subagents"\}/u);
  assert.match(environment, /compact=\{width < 620\}/u);
  assert.match(environment, /chatId=\{panel\.subagents\.chatId\}/u);
  assert.match(environment, /workspaceId=\{panel\.subagents\.workspaceId\}/u);
  assert.match(environment, /detailRequestVersion=\{panel\.subagentFocusDetailVersion\}/u);
  assert.match(
    environment,
    /ownerReplacementFallbackFocusTarget=\{\(\) => activeTabRef\.current\}/u,
  );
  assert.doesNotMatch(
    environment,
    /toggle\("subagents"\)/u,
    "Subagents should reuse the existing Environment entry instead of adding another toolbar toggle.",
  );
});

test("main-derived capabilities gate every renderer entry and repair disabled navigation", () => {
  const appHandler = source("../../main/handlers/app.ts");
  const bootstrap = source("../main/index.tsx");
  const environment = source("./environment-panel.tsx");
  const messages = source("./message-list.tsx");
  const pane = source("../main/chat-pane.tsx");

  assert.match(appHandler, /subagents: subagentsEnabled\(\)/u);
  assert.match(appHandler, /const host = hostPlatformCapabilities\(\)/u);
  assert.match(appHandler, /bots: host\.bots/u);
  assert.match(appHandler, /computerUse: host\.computerUse/u);
  assert.match(bootstrap, /let appCapabilities = DISABLED_APP_CAPABILITIES/u);
  assert.match(bootstrap, /appCapabilities = parseAppCapabilities\(appInfo\.capabilities\)/u);
  assert.match(bootstrap, /capabilities=\{appCapabilities\}/u);
  assert.match(bootstrap, /refresh=\{refreshAppCapabilities\}/u);
  const capabilityProvider = source("../lib/app-capabilities.tsx");
  assert.match(capabilityProvider, /setTimeout\(\(\) => void update\(\), 1_000\)/u);
  assert.match(capabilityProvider, /if \(!cancelled\) setCurrent\(next\)/u);
  assert.match(
    environment,
    /storedEnvironmentPanelTab\(localStorage, TAB_STORAGE_KEY, subagentsEnabled\)/u,
  );
  assert.match(environment, /normalizeEnvironmentPanelTab\(nextTab, subagentsEnabled\)/u);
  assert.match(environment, /if \(!subagentsEnabled\) return;/u);
  assert.match(environment, /\{subagentsEnabled \? \(\s*<SubagentLiveAnnouncer/u);
  assert.match(
    messages,
    /subagentChips=\{\s*subagentsEnabled && message\.subagents \? \(/u,
  );
  assert.match(messages, /subagentChips=\{\s*subagentsEnabled && liveSubagents\.length > 0 \? \(/u);
  assert.match(pane, /visibleSubagentReferences\(messages, environmentPanel\.subagentsEnabled\)/u);
  assert.match(pane, /subagentsEnabled=\{environmentPanel\.subagentsEnabled\}/u);
});

test("the Environment summary exposes conditional current-chat counts and the shared orb", () => {
  const environment = source("./environment-panel.tsx");

  assert.match(
    environment,
    /const hasSubagents =\s+panel\.subagentsEnabled && subagentCounts\.active \+ subagentCounts\.done > 0/u,
  );
  assert.match(environment, /\{hasSubagents \? \(/u);
  assert.match(environment, /panel\.show\("subagents"\)/u);
  assert.match(environment, /<SubagentOrb/u);
  assert.match(environment, /activity=\{representativeSubagent\?\.snapshot\?\.activity\}/u);
  assert.equal(
    (environment.match(/state=\{representativeSubagent\?\.state \?\? "finished"\}/gu) ?? []).length,
    2,
  );
  assert.doesNotMatch(
    environment,
    /state=\{(?:panel\.)?subagentCounts\.active > 0 \? "running" : "finished"\}/u,
  );
  assert.match(environment, /subagentOverviewSummary\(panel\.subagentViews\)/u);
  assert.match(environment, /\{subagentSummary\.primary\}/u);
  assert.match(environment, /\{subagentSummary\.secondary\}/u);
  assert.match(environment, /subagentSummary\.ariaLabel/u);
  assert.match(environment, /min-w-0 truncate text-regular text-primary/u);
  assert.match(environment, /max-w-44 min-w-0 truncate text-small/u);
});

test("live snapshots are owner-checked, revisioned, and released across route transitions", () => {
  const pane = source("../main/chat-pane.tsx");
  const environment = source("./environment-panel.tsx");

  assert.match(pane, /environmentPanel\.subagentsEnabled\s+\?\s+\{\s+onSubagents:/u);
  assert.match(pane, /onSubagents: \(snapshot: SubagentRunSnapshot\) => \{/u);
  assert.match(
    pane,
    /effectiveWorkspaceId = chat\.data\s+\? persistedChatWorkspaceId\(chatWorkspaceId\)\s+: undefined/u,
  );
  assert.match(pane, /selectWorkspace\(effectiveWorkspaceId\)/u);
  assert.match(pane, /snapshot\.chatId !== chatId/u);
  assert.match(pane, /snapshot\.workspaceId !== effectiveWorkspaceId/u);
  assert.match(pane, /mergeSubagentSnapshots\(current, \[snapshot\]/u);
  assert.match(
    pane,
    /environmentPanel\.syncSubagents\(\s*chatId,\s*effectiveWorkspaceId,\s*subagentReferences,\s*displayedLiveSubagents/u,
  );
  assert.match(
    pane,
    /return \(\) => environmentPanel\.releaseSubagents\(chatId, effectiveWorkspaceId\)/u,
  );
  assert.match(environment, /subagentWorkspaceIdRef\.current !== workspaceId/u);
  assert.match(
    environment,
    /mergeSubagentSnapshots\(\[\], liveSnapshots, \{\s*chatId,\s*workspaceId,\s*\}\)/u,
  );
  assert.match(environment, /reconcileSubagentPersistenceHandoff\(/u);
  assert.match(environment, /current\.handoffSnapshots/u);
  assert.match(environment, /\.\.\.subagents\.handoffSnapshots/u);
  assert.match(environment, /buildSubagentRunViews\([\s\S]*subagents\.workspaceId,[\s\S]*\)/u);
  assert.match(environment, /captureSubagentDetailRequest\([\s\S]*workspaceId,[\s\S]*\)/u);
  assert.match(pane, /setLiveSubagents\(\[\]\)/u);
});

test("saved detail failures expose a versioned retry path", () => {
  const environment = source("./environment-panel.tsx");
  const panel = source("./subagents-panel.tsx");

  assert.match(environment, /setSubagentDetailRequestVersion\(\(version\) => version \+ 1\)/u);
  assert.match(environment, /subagentDetailRequestVersion,/u);
  assert.match(environment, /retrySubagentDetail/u);
  assert.match(environment, /setSubagentDetailLoading\(true\)/u);
  assert.match(environment, /handoffSnapshots=\{panel\.subagents\.handoffSnapshots\}/u);
  assert.match(panel, /onRetryDetail/u);
  assert.match(panel, /refreshError=\{savedDetailRefreshError\}/u);
  assert.match(panel, /refreshing=\{savedDetailRefreshing\}/u);
  assert.match(panel, /\sRetry\s*<\/Button>/u);
});

test("production V2 detail wires Stop without advertising unavailable retry", () => {
  const environment = source("./environment-panel.tsx");
  const panel = source("./subagents-panel.tsx");
  const detail = source("./subagent-detail.tsx");

  assert.match(environment, /const stopSubagent = React\.useCallback/u);
  assert.match(environment, /await subagentsApi\.stop\(chatId, run\.runId\)/u);
  assert.match(environment, /beginSubagentStopPending/u);
  assert.match(environment, /clearSubagentStopPending/u);
  assert.match(environment, /failSubagentStopPending/u);
  assert.match(environment, /stopPendingRunIds=\{panel\.subagentStopPendingRunIds\}/u);
  assert.match(environment, /stopErrorsByRunId=\{panel\.subagentStopErrorsByRunId\}/u);
  assert.match(environment, /onStopRun=\{panel\.stopSubagent\}/u);
  assert.match(panel, /stopPending=\{selectedStopPending\}/u);
  assert.match(detail, /disabled=\{stopPending\}/u);
  assert.doesNotMatch(detail, /useState<"stop"/u);
  assert.doesNotMatch(environment, /onRetryRun=/u);
});

test("stop-pending operations are owner-scoped, duplicate-safe, and explicitly settled", () => {
  const ownerOne = JSON.stringify(["chat-one", "workspace-one"]);
  const ownerTwo = JSON.stringify(["chat-two", "workspace-two"]);
  const begun = beginSubagentStopPending(EMPTY_SUBAGENT_STOP_PENDING_STATE, ownerOne, "run-one");
  assert.equal(begun.accepted, true);
  assert.deepEqual(begun.state, { ownerKey: ownerOne, runIds: ["run-one"], errors: {} });

  const duplicate = beginSubagentStopPending(begun.state, ownerOne, "run-one");
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.state, begun.state);

  const selectionIndependent = beginSubagentStopPending(begun.state, ownerOne, "run-two");
  assert.deepEqual(selectionIndependent.state.runIds, ["run-one", "run-two"]);
  const terminalSettled = clearSubagentStopPending(
    selectionIndependent.state,
    ownerOne,
    new Set(["run-one"]),
  );
  assert.deepEqual(terminalSettled.runIds, ["run-two"]);
  const errorSettled = clearSubagentStopPending(terminalSettled, ownerOne, new Set(["run-two"]));
  assert.deepEqual(errorSettled.runIds, []);

  const retryableFailure = failSubagentStopPending(
    beginSubagentStopPending(errorSettled, ownerOne, "run-two").state,
    ownerOne,
    "run-two",
    "Stop unavailable",
  );
  assert.equal(retryableFailure.accepted, true);
  assert.deepEqual(retryableFailure.state.errors, { "run-two": "Stop unavailable" });
  assert.deepEqual(
    beginSubagentStopPending(retryableFailure.state, ownerOne, "run-two").state.errors,
    {},
  );

  assert.deepEqual(replaceSubagentStopPendingOwner(selectionIndependent.state, ownerTwo), {
    ownerKey: ownerTwo,
    runIds: [],
    errors: {},
  });
});

test("authoritative terminal settlement wins over a late Stop rejection", async () => {
  const owner = JSON.stringify(["chat-one", "workspace-one"]);
  let state = beginSubagentStopPending(EMPTY_SUBAGENT_STOP_PENDING_STATE, owner, "run-one").state;
  let rejectRequest!: (reason: unknown) => void;
  const request = new Promise<void>((_resolve, reject) => {
    rejectRequest = reject;
  });
  const settled = request.catch((error: unknown) => {
    const failure = failSubagentStopPending(
      state,
      owner,
      "run-one",
      error instanceof Error ? error.message : "Stop failed",
    );
    state = failure.state;
    return failure.accepted;
  });

  state = clearSubagentStopPending(state, owner, new Set(["run-one"]));
  rejectRequest(new Error("late transport rejection"));

  assert.equal(await settled, false);
  assert.deepEqual(state, { ownerKey: owner, runIds: [], errors: {} });

  const environment = source("./environment-panel.tsx");
  const terminalClear = environment.indexOf("const terminalRunIds = new Set(");
  const stateUpdate = environment.indexOf("commitSubagents((current) => {", terminalClear);
  assert.ok(terminalClear >= 0 && stateUpdate > terminalClear);
  assert.match(
    environment,
    /if \(failure\.accepted\) commitSubagentStopPending\(failure\.state\)/u,
  );
});

test("only a persisted selection starts a saved-detail read and null preserves an error", () => {
  const environment = source("./environment-panel.tsx");
  const detailEffect = between(
    environment,
    "const chatId = subagents.chatId;",
    "React.useEffect(() => {\n    setRendererLifecycleGuard",
  );

  assert.doesNotMatch(detailEffect, /subagents\.liveSnapshots/u);
  assert.doesNotMatch(detailEffect, /subagents\.loadedSnapshots/u);
  assert.doesNotMatch(detailEffect, /\bsubagentViews\b/u);
  assert.match(detailEffect, /selectedSubagentGenerationId/u);
  assert.match(detailEffect, /selectedSubagentReferenceMessageId/u);
  assert.doesNotMatch(detailEffect, /selectedSubagentSnapshotRevision/u);
  assert.match(detailEffect, /!selectedSubagentReferenceMessageId/u);
  assert.match(
    detailEffect,
    /if \(!safeSnapshot\) \{\s*setSubagentDetailError\("Aiden could not refresh this saved subagent\."\)/u,
  );
  assert.match(detailEffect, /const requestBaselineSnapshot = mergeSubagentSnapshots\(/u);
  assert.match(detailEffect, /\.\.\.subagentsRef\.current\.liveSnapshots/u);
  assert.match(detailEffect, /requestBaselineSnapshot,/u);
  assert.match(detailEffect, /const accepted = commitSubagents\(\(current\) => \{/u);
  assert.match(detailEffect, /mergeSubagentHistorySnapshot\(/u);
  assert.match(detailEffect, /loadedSnapshots: merged\.loadedSnapshots/u);
  assert.ok(
    detailEffect.indexOf("if (!accepted)") < detailEffect.indexOf("setSubagentEffectDetail"),
  );
});

test("subagent context commits synchronously through one ref-backed authority", () => {
  const environment = source("./environment-panel.tsx");
  assert.doesNotMatch(environment, /subagentsRef\.current = subagents/u);
  assert.match(environment, /const commitSubagents = React\.useCallback/u);
  assert.match(environment, /const current = subagentsRef\.current/u);
  assert.match(environment, /subagentsRef\.current = next/u);
  assert.match(environment, /setRenderedSubagents\(next\)/u);
  assert.equal(environment.match(/setRenderedSubagents\(/gu)?.length, 1);
  assert.doesNotMatch(environment, /\bsetSubagents\(/u);
  assert.match(environment, /generationId: safeSnapshot\.generationId/u);
  assert.match(environment, /revision: safeSnapshot\.revision/u);
  assert.match(
    environment,
    /subagentEffectDetail\.revision === displayedSubagentView\?\.snapshot\?\.revision/u,
  );
});

test("persisted and live chips share one transcript integration path", () => {
  const messages = source("./message-list.tsx");
  const chips = source("./subagent-chips.tsx");

  assert.match(messages, /message\.subagents \? \(/u);
  assert.match(messages, /<SubagentChips reference=\{message\.subagents\}/u);
  assert.match(messages, /<SubagentChips runs=\{liveSubagents\}/u);
  assert.match(messages, /liveSubagents\.length > 0/u);
  assert.match(messages, /onOpen=\{onOpenSubagent\}/u);
  assert.doesNotMatch(chips, /aria-live=/u);
  assert.doesNotMatch(chips, /subagentSnapshotLiveSummary/u);
});

test("the composed Subagents UI routes activity and detail lifecycle through one polite region", () => {
  const environment = source("./environment-panel.tsx");
  const announcer = source("./subagent-live-announcer.tsx");
  const panel = source("./subagents-panel.tsx");
  const detail = source("./subagent-detail.tsx");
  const chips = source("./subagent-chips.tsx");
  const panelState = source("../lib/subagent-panel-state.ts");

  assert.equal((announcer.match(/data-subagent-live-announcer="true"/gu) ?? []).length, 1);
  assert.match(announcer, /subagentSnapshotLiveSummary\(runs\)/u);
  assert.match(announcer, /new SubagentLiveAnnouncementCoordinator\(/u);
  assert.match(announcer, /coordinatorRef\.current\?\.update\(ownerKey, summary, terminal\)/u);
  assert.match(announcer, /window\.setTimeout\(callback, delayMs\)/u);
  assert.match(announcer, /coordinatorRef\.current\?\.announceDetail/u);
  assert.match(announcer, /portalHost \? createPortal\(region, portalHost\) : region/u);
  assert.match(environment, /ref=\{setSurfaceRef\}/u);
  assert.match(environment, /setSubagentAnnouncerHost\(node\)/u);
  assert.match(environment, /open && tab !== "overview" \? subagentAnnouncerHost : null/u);
  assert.doesNotMatch(environment, /data-environment-modal-background="subagent-announcer"/u);
  assert.match(environment, /onDetailAnnouncement=\{panel\.announceSubagentDetail\}/u);
  assert.equal(
    (
      `${environment}\n${announcer}\n${panel}\n${detail}\n${chips}`.match(/aria-live="polite"/gu) ??
      []
    ).length,
    1,
    "the portaled node is the composed Subagents UI's only polite live region",
  );
  assert.equal(
    (`${environment}\n${announcer}\n${panel}\n${chips}`.match(/role="status"/gu) ?? []).length,
    1,
  );
  assert.match(announcer, /aria-atomic="true"/u);
  assert.doesNotMatch(chips, /aria-live=/u);
  assert.doesNotMatch(panel, /aria-live=/u);
  assert.doesNotMatch(detail, /aria-live=/u);
  assert.doesNotMatch(panel, /role="status"/u);
  assert.doesNotMatch(panel, /data-subagent-detail-announcer/u);
  assert.match(panel, /onDetailAnnouncement\?\.\(ownerKey, message\)/u);
  assert.match(panelState, /Loading saved activity for/u);
  assert.match(panelState, /Saved activity \$\{action\} for/u);
  assert.match(panelState, /Could not load saved activity for/u);
  assert.match(panelState, /Could not refresh saved activity for/u);
  assert.doesNotMatch(panelState, /return `\$\{next\.label\}: \$\{next\.activity\}\.`/u);
});

test("the shell reconciles lifecycle-detached terminal chats without per-stream listeners", () => {
  const root = source("../main/root-view.tsx");
  const ipc = source("../lib/ipc.ts");
  const pane = source("../main/chat-pane.tsx");

  assert.match(root, /subscribeDetachedTerminalChats\(\s+onNotification/u);
  assert.match(root, /await queryClient\.cancelQueries\(\{ queryKey: chatKey, exact: true \}\)/u);
  assert.match(root, /preferLatestTerminalChat\(current, chat\)/u);
  assert.match(
    root,
    /queryClient\.fetchQuery\(\{\s+queryKey: chatKey,\s+queryFn: \(\) => chatsApi\.get\(chatId\),\s+staleTime: 0,\s+\}\)/u,
  );
  assert.match(
    ipc,
    /rememberDetachedLifecycleStream\(\s+\{\s+streamId,\s+chatId: params\.chatId,\s+workspaceId: params\.workspaceId \?\? "default",\s+\},\s+\{\s+content: projectedContent,\s+lastTextDeltaAt: projectedLastTextDeltaAt,\s+reasoning: projectedReasoning,\s+timeline: projectedTimeline,\s+artifacts: projectedArtifacts,\s+subagents: projectedSubagents,/u,
  );
  assert.match(pane, /React\.useSyncExternalStore\(\s+subscribeDetachedLifecycleStreams/u);
  assert.match(pane, /detachedLifecycleChatProjection\(chatId, effectiveWorkspaceId\)/u);
  assert.match(pane, /detachedGenerationDraining\s+\? "Response continues in the background…"/u);
  assert.match(
    pane,
    /messages\[messages\.length - 1\]\?\.role === "assistant" \? null : detachedProjection/u,
  );
  assert.match(pane, /liveSubagents=\{displayedLiveSubagents\}/u);
  assert.match(pane, /streamingText=\{displayedStreamingText\}/u);
  assert.match(
    pane,
    /if \(detachedGenerationDraining\) \{\s+throw new Error\("Wait for the previous response to finish saving before sending again\."\)/u,
  );
});

test("chip focus survives live-to-persisted replacement by run identity", () => {
  const environment = source("./environment-panel.tsx");
  const chips = source("./subagent-chips.tsx");
  const messages = source("./message-list.tsx");

  assert.match(chips, /data-subagent-chip-run-id=\{runId\}/u);
  assert.match(messages, /data-subagent-chip-focus-scope="true"/u);
  assert.match(messages, /document\.addEventListener\("focusin", onFocusIn, true\)/u);
  assert.match(messages, /document\.addEventListener\("pointerdown", onPointerDown, true\)/u);
  assert.match(messages, /retainSubagentChipFocusAfterPointerDown/u);
  assert.match(messages, /resolveSubagentChipFocusHandoff/u);
  assert.match(messages, /\[document\.body, document\.documentElement\]/u);
  assert.match(messages, /handoff\.target\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(environment, /querySelectorAll<HTMLElement>\("\[data-subagent-chip-run-id\]"\)/u);
  assert.match(
    environment,
    /element\.dataset\.subagentChipRunId === returnSubagentRunIdRef\.current/u,
  );
  assert.match(environment, /\[data-subagent-detail-heading\]/u);
});
