import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { emitBotTestNotification, installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import type { HookListing, HookProposal, HooksOverview } from "../../shared/hooks-settings";
import { HooksSettings } from "./hooks-settings";

afterEach(cleanup);

const WORKSPACE = "/Users/ada/code/shop";
const digest = (seed: string) => seed.repeat(64).slice(0, 64);

function listing(overrides: Partial<HookListing> & Pick<HookListing, "id" | "name">): HookListing {
  return {
    event: "PreToolUse",
    configuredEvent: overrides.event === "unknown" ? "TeammateIdle" : (overrides.event ?? "PreToolUse"),
    configuredType: "command",
    matcher: "Bash",
    handler: { type: "command", command: `./${overrides.id}.sh` },
    scope: { kind: "global" },
    source: "settings",
    digest: digest("a"),
    status: "active",
    ...overrides,
  };
}

const HOOKS: HookListing[] = [
  listing({ id: "hk_guard", name: "Guard shell", handler: { type: "command", command: "~/.aiden/hooks/guard.sh" } }),
  listing({
    id: "workspace:shop:PreToolUse:0",
    name: "Lint on edit",
    event: "PostToolUse",
    matcher: "Edit|Write",
    handler: { type: "command", command: "npm run lint --silent" },
    scope: { kind: "workspace", workspaceRoot: WORKSPACE },
    source: "workspace-file",
    digest: digest("b"),
    status: "waiting-for-approval",
  }),
  listing({
    id: "workspace:shop:Stop:0",
    name: "Tests before done",
    event: "Stop",
    matcher: "",
    handler: { type: "command", command: "npm test" },
    scope: { kind: "workspace", workspaceRoot: WORKSPACE },
    source: "workspace-file",
    digest: digest("c"),
    status: "changed",
  }),
  listing({
    id: "workspace:shop:unknown:0",
    name: "Idle ping",
    event: "unknown",
    matcher: "",
    handler: { type: "command", command: "./ping.sh" },
    scope: { kind: "workspace", workspaceRoot: WORKSPACE },
    source: "workspace-file",
    digest: digest("d"),
    status: "unsupported",
    unsupportedReason: "Aiden has no TeammateIdle event.",
  }),
];

function overview(overrides: Partial<HooksOverview> = {}): HooksOverview {
  return {
    available: true,
    hooks: [],
    paused: false,
    disabledByEnvironment: false,
    workspaceFiles: [],
    proposals: [],
    workspaces: [{ workspaceRoot: WORKSPACE, name: "Shop" }],
    ...overrides,
  };
}

function mount(initial: HooksOverview, handlers: Record<string, (...args: unknown[]) => unknown> = {}) {
  let current = initial;
  const calls = installBotTestIpc({
    "hooks:list": () => current,
    "hooks:runLog": () => [],
    "hooks:setPaused": (paused: unknown) => {
      current = { ...current, paused: paused as boolean };
      return true;
    },
    "hooks:setEnabled": () => true,
    ...handlers,
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <HooksSettings />
    </QueryClientProvider>,
  );
  const callsTo = (channel: string) => calls.filter((call) => call.channel === channel).map((call) => call.args);
  return { callsTo, set: (next: HooksOverview) => void (current = next) };
}

test("each row shows its command and status, grouped by where it applies", async () => {
  mount(overview({ hooks: HOOKS }));
  await screen.findByText("~/.aiden/hooks/guard.sh");
  for (const status of ["Active", "Waiting for approval", "Changed — re-approve", "Not supported in Aiden"]) {
    screen.getByText(status);
  }
  screen.getByText("Aiden has no TeammateIdle event.");
  screen.getByText("PostToolUse · Edit|Write");
  screen.getByText("Global");
  screen.getByText("Shop");
  screen.getByText(WORKSPACE);
  assert.equal(screen.getByRole("switch", { name: "Run Idle ping" }).hasAttribute("disabled"), true, "an unsupported hook can't be turned on");
  assert.equal(screen.getByRole("switch", { name: "Run Idle ping" }).getAttribute("aria-checked"), "false");
  assert.equal(screen.getByRole("switch", { name: "Run Guard shell" }).getAttribute("aria-checked"), "true");
  // A hook that won't run until it's approved shows off, and Approve is its action.
  for (const name of ["Lint on edit", "Tests before done"]) {
    const toggle = screen.getByRole("switch", { name: `Run ${name}` });
    assert.equal(toggle.getAttribute("aria-checked"), "false", `${name} isn't running yet`);
    assert.equal(toggle.hasAttribute("disabled"), true, `${name} is approved, not switched on`);
  }
  // Only hooks that wait for the owner offer approval.
  assert.equal(screen.getAllByRole("button", { name: /^(Approve|Re-approve)$/u }).length, 2);
});

test("approving a repo hook confirms the command, then sends the digest that was shown", async () => {
  const { callsTo } = mount(overview({ hooks: HOOKS }), {
    "hooks:approveDigest": () => ({ ok: true, value: { ...HOOKS[1], status: "active" } }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  const confirm = await screen.findByRole("alertdialog");
  within(confirm).getByText("npm run lint --silent");
  assert.deepEqual(callsTo("hooks:approveDigest"), [], "nothing is approved before the owner confirms");
  fireEvent.click(within(confirm).getByRole("button", { name: "Approve" }));
  await waitFor(() => assert.deepEqual(callsTo("hooks:approveDigest"), [["workspace:shop:PreToolUse:0", digest("b")]]));
});

/** The value next to a label in a detail list, or null when the row isn't shown. */
function detail(container: HTMLElement, label: string): string | null {
  const term = within(container).queryByText(label, { selector: "dt" });
  return term ? (term.nextElementSibling?.textContent ?? "") : null;
}

test("the approval confirmation shows how the hook runs and what its approval can't cover", async () => {
  const background = listing({
    id: "workspace:shop:PostToolUse:1",
    name: "Notify",
    event: "PostToolUse",
    handler: { type: "command", command: "./scripts/notify.sh && npx tsx send.ts", async: true, timeout: 300, envAllow: ["SLACK_TOKEN", "CHANNEL"] },
    scope: { kind: "workspace", workspaceRoot: WORKSPACE },
    source: "workspace-file",
    digest: digest("e"),
    status: "waiting-for-approval",
    scriptFiles: ["scripts/notify.sh"],
    scriptCoverage: "partial",
  });
  const guard = listing({
    id: "workspace:shop:PreToolUse:2",
    name: "Strict guard",
    handler: { type: "command", command: "./guard.sh", failClosed: true },
    scope: { kind: "workspace", workspaceRoot: WORKSPACE },
    source: "workspace-file",
    digest: digest("f"),
    status: "changed",
  });
  mount(overview({ hooks: [background, guard] }));

  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  let confirm = await screen.findByRole("alertdialog");
  assert.equal(detail(confirm, "Timeout"), "300 seconds");
  assert.match(detail(confirm, "In the background") ?? "", /^Yes/u);
  assert.equal(detail(confirm, "Extra environment"), "SLACK_TOKEN, CHANNEL");
  assert.equal(detail(confirm, "If it fails"), null, "an async hook can't block, so the confirmation doesn't offer it");
  assert.deepEqual(
    within(within(confirm).getByRole("list", { name: "Script files" })).getAllByRole("listitem").map((item) => item.textContent),
    ["scripts/notify.sh"],
  );
  assert.match(within(confirm).getByRole("note").textContent ?? "", /can’t check every file this command runs/u);
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));

  fireEvent.click(screen.getByRole("button", { name: "Re-approve" }));
  confirm = await screen.findByRole("alertdialog");
  assert.equal(detail(confirm, "Timeout"), "30 seconds");
  assert.equal(detail(confirm, "In the background"), "No");
  assert.equal(detail(confirm, "If it fails"), "Block the tool");
  assert.equal(detail(confirm, "Extra environment"), "None");
  assert.equal(within(confirm).queryByRole("note"), null, "a fully followed command has no coverage warning");
});

test("an edit that only moves a hook into the background shows as a change", async () => {
  const before = HOOKS[0]!;
  const proposal: HookProposal = {
    ...PROPOSAL_BASE,
    id: "hp_cccccccccccc",
    action: "update",
    hookId: before.id,
    summary: "Don't hold up the shell.",
    definition: { ...before, event: "PreToolUse", handler: { ...before.handler, async: true } },
  };
  mount(overview({ hooks: [before], proposals: [proposal] }));
  const edited = await screen.findByLabelText("What Guard shell will run");
  assert.deepEqual(
    within(edited).getAllByText(/^(Yes|No)$/u).map((line) => line.textContent),
    ["− Before: No", "+ After: Yes"],
  );
  within(edited).getByText("In the background");
});

test("Pause all hooks saves at once and comes back off when main refuses", async () => {
  const { callsTo } = mount(overview({ hooks: HOOKS }));
  const pause = await screen.findByRole("switch", { name: "Pause all hooks" });
  await waitFor(() => assert.equal(pause.hasAttribute("disabled"), false));
  fireEvent.click(pause);
  await waitFor(() => assert.deepEqual(callsTo("hooks:setPaused"), [[true]]));
  await waitFor(() => assert.equal(screen.getByRole("switch", { name: "Pause all hooks" }).getAttribute("aria-checked"), "true"));
  cleanup();

  mount(overview({ hooks: HOOKS }), {
    "hooks:setPaused": () => {
      throw new Error("disk full");
    },
  });
  const failing = await screen.findByRole("switch", { name: "Pause all hooks" });
  await waitFor(() => assert.equal(failing.hasAttribute("disabled"), false));
  fireEvent.click(failing);
  await waitFor(() => assert.equal(failing.hasAttribute("disabled"), false));
  assert.equal(failing.getAttribute("aria-checked"), "false");
});

test("a row switch turns its hook off by id", async () => {
  const { callsTo } = mount(overview({ hooks: HOOKS }));
  fireEvent.click(await screen.findByRole("switch", { name: "Run Guard shell" }));
  await waitFor(() => assert.deepEqual(callsTo("hooks:setEnabled"), [["hk_guard", false]]));
});

test("a hook Aiden turned off after failures shows off, and its switch turns it back on", async () => {
  const failing = listing({ id: "hk_flaky", name: "Flaky check", status: "disabled-after-failures" });
  const { callsTo, set } = mount(overview({ hooks: [failing] }), {
    "hooks:setEnabled": () => {
      set(overview({ hooks: [{ ...failing, status: "active" }] }));
      return true;
    },
  });
  await screen.findByText("Disabled after failures");
  const toggle = screen.getByRole("switch", { name: "Run Flaky check" });
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(toggle.hasAttribute("disabled"), false);
  fireEvent.click(toggle);
  await waitFor(() => assert.deepEqual(callsTo("hooks:setEnabled"), [["hk_flaky", true]]));
  await screen.findByText("Active");
  assert.equal(screen.getByRole("switch", { name: "Run Flaky check" }).getAttribute("aria-checked"), "true");
});

/** Add hook lives in the page heading and is ready once the hook service has answered. */
async function openAddSheet() {
  const add = await screen.findByRole("button", { name: "Add hook" });
  await waitFor(() => assert.equal(add.hasAttribute("disabled"), false));
  fireEvent.click(add);
  return screen.findByRole("dialog");
}

test("with no hooks the page explains them in one line and offers Add hook; AIDEN_HOOKS=0 is called out", async () => {
  mount(overview({ disabledByEnvironment: true }));
  await screen.findByText("No hooks yet");
  screen.getByText(/A hook runs your own shell command/u);
  screen.getByText(/AIDEN_HOOKS=0 is set/u);
  assert.equal(screen.getAllByRole("button", { name: "Add hook" }).length, 1, "one Add hook, in the page heading");
  assert.ok(screen.getByRole("heading", { level: 1, name: "Hooks" }));
});

test("the first read shows a skeleton under the heading, and Add hook waits for the hook service", async () => {
  let answer: (value: HooksOverview) => void = () => {};
  const pending = new Promise<HooksOverview>((resolve) => {
    answer = resolve;
  });
  mount(overview(), { "hooks:list": () => pending });
  await screen.findByRole("status", { name: "Reading your hooks" });
  screen.getByRole("heading", { level: 1, name: "Hooks" });
  assert.equal(screen.getByRole("button", { name: "Add hook" }).hasAttribute("disabled"), true);
  answer(overview());
  await screen.findByText("No hooks yet");
  assert.equal(screen.queryByRole("status", { name: "Reading your hooks" }) === null, true);
  assert.equal(screen.getByRole("button", { name: "Add hook" }).hasAttribute("disabled"), false);
});

test("Add hook is off while the hook service hasn't started", async () => {
  mount(overview({ available: false }));
  const add = await screen.findByRole("button", { name: "Add hook" });
  await waitFor(() => assert.equal(screen.queryByRole("status", { name: "Reading your hooks" }) === null, true));
  assert.equal(add.hasAttribute("disabled"), true);
});

test("the page re-reads when main says hooks changed", async () => {
  const { set } = mount(overview());
  await screen.findByText("No hooks yet");
  set(overview({ hooks: [HOOKS[0]!] }));
  emitBotTestNotification("hooks:changed", { reason: "hooks" });
  await screen.findByText("~/.aiden/hooks/guard.sh");
});

const PROPOSAL_BASE: Omit<HookProposal, "id" | "action" | "hookId" | "definition" | "summary"> = {
  origin: "agent",
  digest: digest("e"),
  warnings: [],
  createdAt: Date.UTC(2026, 9, 31, 12),
  expiresAt: Date.UTC(2026, 9, 31, 13),
};

test("an agent proposal shows exactly what will run, and its edit as a before and after", async () => {
  const create: HookProposal = {
    ...PROPOSAL_BASE,
    id: "hp_aaaaaaaaaaaa",
    action: "create",
    hookId: "hk_new",
    summary: "Runs prettier after edits in this chat.",
    warnings: ["It can read files in this workspace."],
    definition: {
      id: "hk_new",
      name: "Format on edit",
      event: "PostToolUse",
      matcher: "Edit",
      handler: { type: "command", command: "npx prettier --write ." },
      scope: { kind: "chat", chatId: "chat-1" },
      source: "agent",
      digest: digest("e"),
    },
  };
  const update: HookProposal = {
    ...PROPOSAL_BASE,
    id: "hp_bbbbbbbbbbbb",
    action: "update",
    hookId: "hk_guard",
    summary: "Also guard git pushes.",
    definition: { ...HOOKS[0]!, event: "PreToolUse", handler: { type: "command", command: "~/.aiden/hooks/guard.sh --git" } },
  };
  const { callsTo } = mount(overview({ hooks: [HOOKS[0]!], proposals: [create, update] }), {
    "hooks:approveProposal": () => ({ ok: true, value: undefined }),
    "hooks:rejectProposal": () => true,
  });
  const created = await screen.findByLabelText("What Format on edit will run");
  within(created).getByText("npx prettier --write .");
  within(created).getByText("It can read files in this workspace.");

  const edited = screen.getByLabelText("What Guard shell will run");
  assert.deepEqual(
    within(edited).getAllByText(/guard\.sh/u).map((line) => line.textContent),
    ["− Before: ~/.aiden/hooks/guard.sh", "+ After: ~/.aiden/hooks/guard.sh --git"],
  );
  assert.equal(within(edited).queryByText("Event") === null, true, "fields that don't change are left out");

  fireEvent.click(within(created).getByRole("button", { name: "Approve" }));
  fireEvent.click(within(edited).getByRole("button", { name: "Reject" }));
  await waitFor(() => assert.deepEqual(callsTo("hooks:approveProposal"), [["hp_aaaaaaaaaaaa"]]));
  await waitFor(() => assert.deepEqual(callsTo("hooks:rejectProposal"), [["hp_bbbbbbbbbbbb"]]));
});

test("Add hook saves a global PreToolUse hook with its tools, timeout and Block if the hook fails", async () => {
  const { callsTo } = mount(overview(), {
    "hooks:save": () => ({ ok: true, value: HOOKS[0] }),
  });
  const sheet = await openAddSheet();
  const add = within(sheet).getByRole("button", { name: "Add hook" });
  assert.equal(add.hasAttribute("disabled"), true, "a command is required");
  fireEvent.change(within(sheet).getByLabelText("Command"), { target: { value: "  ./guard.sh  " } });
  fireEvent.change(within(sheet).getByLabelText("Tools"), { target: { value: "Bash" } });
  fireEvent.change(within(sheet).getByLabelText("Timeout"), { target: { value: "500" } });
  assert.equal(add.hasAttribute("disabled"), true, "a timeout over 120 seconds is refused");
  fireEvent.change(within(sheet).getByLabelText("Timeout"), { target: { value: "15" } });
  fireEvent.click(within(sheet).getByRole("switch", { name: "Block if the hook fails" }));
  fireEvent.click(add);
  await waitFor(() =>
    assert.deepEqual(callsTo("hooks:save"), [
      [{ scope: { kind: "global" }, event: "PreToolUse", command: "./guard.sh", matcher: "Bash", timeout: 15, failClosed: true }],
    ]),
  );
});

test("a refused save stays open with main's reason", async () => {
  mount(overview(), {
    "hooks:save": () => ({ ok: false, reason: "That command is too long." }),
  });
  const sheet = await openAddSheet();
  fireEvent.change(within(sheet).getByLabelText("Command"), { target: { value: "./x.sh" } });
  fireEvent.click(within(sheet).getByRole("button", { name: "Add hook" }));
  await within(sheet).findByText("That command is too long.");
});

test("the detail sheet tests only on the Test press, and asks first for a hook that isn't approved", async () => {
  const { callsTo } = mount(overview({ hooks: HOOKS }), {
    "hooks:test": () => ({
      ok: true,
      value: {
        matched: true,
        payload: { hook_event_name: "PostToolUse", session_id: "settings-test", cwd: WORKSPACE },
        exitCode: 0,
        timedOut: false,
        durationMs: 12,
        stdout: "lint ok",
        stderr: "",
        result: {},
        outcome: {},
      },
    }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Lint on edit" }));
  const sheet = await screen.findByRole("dialog");
  within(sheet).getByText(digest("b").slice(0, 12));
  within(sheet).getByText("From the repo’s .aiden/hooks.json");
  assert.deepEqual(callsTo("hooks:test"), [], "opening the sheet runs nothing");
  fireEvent.click(within(sheet).getByRole("button", { name: "Test" }));
  const confirm = await screen.findByRole("alertdialog");
  assert.deepEqual(callsTo("hooks:test"), []);
  fireEvent.click(within(confirm).getByRole("button", { name: "Run once" }));
  await waitFor(() => assert.deepEqual(callsTo("hooks:test"), [["workspace:shop:PreToolUse:0", digest("b")]], "the test is pinned to the version on screen"));
  await screen.findByText("lint ok");
});

test("Add hook offers only the events the chosen place can run, and resets one it can't", async () => {
  const { callsTo } = mount(overview(), {
    "hooks:save": () => ({ ok: true, value: HOOKS[0] }),
  });
  const sheet = await openAddSheet();
  fireEvent.click(within(sheet).getByRole("combobox", { name: "When" }));
  const everyChat = (await screen.findAllByRole("option")).map((option) => option.textContent);
  assert.ok(everyChat.includes("RoutineRun"), "a global hook can follow Bot routines");
  fireEvent.click(screen.getByRole("option", { name: "RoutineRun" }));
  await waitFor(() => assert.match(within(sheet).getByRole("combobox", { name: "When" }).textContent ?? "", /RoutineRun/u));

  fireEvent.click(within(sheet).getByRole("combobox", { name: "Where" }));
  fireEvent.click(await screen.findByRole("option", { name: "Shop" }));
  await waitFor(() => assert.doesNotMatch(within(sheet).getByRole("combobox", { name: "When" }).textContent ?? "", /RoutineRun/u));

  fireEvent.click(within(sheet).getByRole("combobox", { name: "When" }));
  const inShop = (await screen.findAllByRole("option")).map((option) => option.textContent);
  assert.ok(inShop.includes("WorktreeSetup"));
  for (const routineEvent of ["RoutineRun", "RoutineFailed"]) {
    assert.equal(inShop.includes(routineEvent), false, `a workspace hook never sees ${routineEvent}`);
  }
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

  fireEvent.change(within(sheet).getByLabelText("Command"), { target: { value: "./x.sh" } });
  fireEvent.click(within(sheet).getByRole("button", { name: "Add hook" }));
  await waitFor(() => assert.equal(callsTo("hooks:save").length, 1));
  const [[request]] = callsTo("hooks:save") as [[{ scope: unknown; event: string }]];
  assert.deepEqual(request.scope, { kind: "workspace", workspaceRoot: WORKSPACE });
  assert.notEqual(request.event, "RoutineRun", "the saved event is one the workspace can run");
});

test("the detail sheet lists a repo hook's script files and warns when it can't check them all", async () => {
  const scripted = {
    ...HOOKS[1]!,
    handler: { type: "command" as const, command: "./scripts/lint.sh && npx eslint ." },
    scriptFiles: ["scripts/lint.sh", "scripts/lib/common.sh"],
    scriptCoverage: "partial" as const,
  };
  mount(overview({ hooks: [scripted] }));
  fireEvent.click(await screen.findByRole("button", { name: "Lint on edit" }));
  const sheet = await screen.findByRole("dialog");
  const files = within(sheet).getByRole("list", { name: "Script files" });
  assert.deepEqual(
    within(files).getAllByRole("listitem").map((item) => item.textContent),
    ["scripts/lint.sh", "scripts/lib/common.sh"],
  );
  within(sheet).getByText(/Editing one of these files asks you to approve the hook again/u);
  assert.match(within(sheet).getByRole("note").textContent ?? "", /can’t check every file this command runs/u);
});

test("a hook with nothing to follow shows no script section", async () => {
  mount(overview({ hooks: [HOOKS[0]!] }));
  fireEvent.click(await screen.findByRole("button", { name: "Guard shell" }));
  const sheet = await screen.findByRole("dialog");
  assert.equal(within(sheet).queryByRole("list", { name: "Script files" }) === null, true);
  assert.equal(within(sheet).queryByRole("note") === null, true);
});

test("Last runs shows a placeholder, not an empty list, until the run log arrives", async () => {
  let answer: (runs: unknown[]) => void = () => {};
  const runs = new Promise<unknown[]>((resolve) => {
    answer = resolve;
  });
  const startedAt = Date.UTC(2026, 9, 31, 12);
  mount(overview({ hooks: [HOOKS[0]!] }), { "hooks:runLog": () => runs });
  fireEvent.click(await screen.findByRole("button", { name: "Guard shell" }));
  const sheet = await screen.findByRole("dialog");
  await within(sheet).findByRole("status", { name: "Reading its runs" });
  assert.equal(within(sheet).queryByRole("list", { name: "Last runs" }) === null, true);
  const run = { hookId: "hk_guard", event: "PreToolUse", startedAt, durationMs: 4, exitCode: 0, timedOut: false, outputExcerpt: "", result: "ok" };
  // Two runs that started together are both listed.
  answer([run, { ...run, exitCode: 2, result: "blocked" }]);
  const list = await within(sheet).findByRole("list", { name: "Last runs" });
  assert.equal(within(list).getAllByRole("listitem").length, 2);
  assert.equal(within(sheet).queryByRole("status", { name: "Reading its runs" }) === null, true);
});

test("Delete asks first, then deletes the hook by id", async () => {
  const { callsTo } = mount(overview({ hooks: [HOOKS[0]!] }), {
    "hooks:delete": () => ({ ok: true, value: undefined }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Guard shell" }));
  const sheet = await screen.findByRole("dialog");
  fireEvent.click(within(sheet).getByRole("button", { name: "Delete" }));
  const confirm = await screen.findByRole("alertdialog");
  assert.deepEqual(callsTo("hooks:delete"), [], "nothing is deleted before the owner confirms");
  fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  await waitFor(() => assert.deepEqual(callsTo("hooks:delete"), [["hk_guard"]]));
});
