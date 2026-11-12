import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  describeToolApprovalRule,
  rememberableApprovalScopes,
  toolApprovalScopeLabel,
} from "../../shared/tool-approval-scope.js";
import type { ApprovalRuleAddInput, ApprovalRuleDecision, ApprovalRulePickerOption, ApprovalRuleRow } from "../../shared/approval-rules.js";
import {
  AddApprovalRuleDialog,
  ApprovalRulesSettingsView,
  approvalRuleRowKey,
  typedRuleOptions,
  type ApprovalRulesSettingsViewProps,
} from "./approval-rules-settings.js";

afterEach(cleanup);

const ROWS: ApprovalRuleRow[] = [
  { ref: { source: "rule", id: "r1" }, group: "allow", title: "Gmail", kind: "Connected app", scope: { kind: "mac" }, decisions: ["allow", "ask", "block"], createdAt: "2026-11-01T00:00:00.000Z" },
  { ref: { source: "bot-allow", botId: "bot:ada", entryId: "e1" }, group: "allow", title: "calendar.example", kind: "Site", scope: { kind: "bot", label: "Ada" }, legacy: true, decisions: ["allow", "ask", "block"] },
  { ref: { source: "bot-rule", botId: "bot:ada", ruleId: "custom.1" }, group: "ask", title: "Book a flight", kind: "When a Bot wants to", scope: { kind: "bot", label: "Ada" }, legacy: true, decisions: ["ask", "block"], handOff: { on: true } },
  { ref: { source: "rule", id: "r2" }, group: "block", title: "bank.example", kind: "Site", scope: { kind: "mac" }, decisions: ["allow", "ask", "block"] },
  { ref: { source: "workspace-mac", workspaceId: "w1", grant: "shell" }, group: "mac", title: "Run commands", kind: "Mac", scope: { kind: "workspace", label: "Aiden" }, decisions: [] },
];

function view(extra: Partial<ApprovalRulesSettingsViewProps> = {}) {
  const calls: string[] = [];
  const props: ApprovalRulesSettingsViewProps = {
    rows: ROWS,
    error: null,
    mode: "ask",
    pending: null,
    onDecide: (row, decision) => calls.push(`decide ${row.title} ${decision}`),
    onHandOff: (row, on) => calls.push(`handoff ${row.title} ${on}`),
    onRemove: (row) => calls.push(`remove ${row.title}`),
    onAdd: (decision) => calls.push(`add ${decision}`),
    onOpenSection: (section) => calls.push(`open ${section}`),
    onRetry: () => calls.push("retry"),
    ...extra,
  };
  render(<ApprovalRulesSettingsView {...props} />);
  return calls;
}

const group = (title: string) => screen.getByRole("heading", { name: title }).closest("section")!;

test("rows land in their group with who they answer for, and the Mac's grants read and remove only", () => {
  view();
  assert.ok(within(group("Always allow")).getByText("Gmail"));
  assert.ok(within(group("Always allow")).getByText(/Site · Only for Ada/u));
  assert.ok(within(group("Always ask")).getByText(/When a Bot wants to · Only for Ada · You do it yourself/u));
  assert.ok(within(group("Blocked")).getByText("bank.example"));
  const mac = group("Allowed on this Mac");
  assert.equal(within(mac).queryAllByRole("radiogroup").length, 0, "a Mac grant has no decision to change");
  assert.ok(within(mac).getByRole("button", { name: "Remove: Run commands" }));
});

test("the segmented control and Remove report the row they belong to", () => {
  const calls = view();
  const gmail = screen.getByRole("radiogroup", { name: "Decision for Gmail" });
  fireEvent.click(within(gmail).getByRole("radio", { name: "Block" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove: calendar.example" }));
  fireEvent.click(within(group("Blocked")).getByRole("button", { name: "Add a rule to Blocked" }));
  assert.deepEqual(calls, ["decide Gmail block", "remove calendar.example", "add block"]);
  // A words rule offers only Ask and Block.
  const words = screen.getByRole("radiogroup", { name: "Decision for Book a flight" });
  assert.deepEqual(within(words).getAllByRole("radio").map((radio) => radio.textContent), ["Ask", "Block"]);
});

test("in Never ask only Block rules apply: the page says so and the other rows read as dimmed", () => {
  view({ mode: "never" });
  assert.ok(screen.getByText(/In Never ask, only Block rules apply/u));
  const dimmed = (title: string) => screen.getByRole("group", { name: title }).className.includes("opacity-55");
  assert.equal(dimmed("Gmail"), true);
  assert.equal(dimmed("Book a flight"), false, "Do it myself still hands the step to the person in Never ask");
  assert.equal(dimmed("bank.example"), false);
  assert.equal(dimmed("Run commands"), false);
});

test("a save in flight disables every row's controls and names the busy row", () => {
  view({ pending: approvalRuleRowKey(ROWS[1]!.ref) });
  assert.equal((screen.getByRole("button", { name: "Remove: calendar.example" }) as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByText("Removing…"));
  for (const radio of screen.getAllByRole("radio")) assert.equal((radio as HTMLButtonElement).disabled, true);
});

test("loading and a failed read offer no rule actions; Try again reads again", () => {
  view({ rows: null });
  assert.ok(screen.getByRole("status"));
  assert.equal(screen.queryAllByRole("button", { name: /Remove|Add a rule/u }).length, 0);
  cleanup();
  const calls = view({ rows: null, error: "Aiden couldn’t read your rules." });
  assert.ok(screen.getByRole("alert"));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  assert.deepEqual(calls, ["retry"]);
});

test("the trust links open their pages, and the locked note is always there", () => {
  const calls = view({ rows: [] });
  fireEvent.click(screen.getByRole("button", { name: "Open Hooks" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Paired devices" }));
  assert.deepEqual(calls, ["open hooks", "open remoteAccess"]);
  assert.ok(screen.getByText(/Passwords, two-factor codes and money always come to you/u));
  assert.ok(within(group("Always allow")).getByText(/Choose Always on a card/u));
});

test("what the person types becomes a site or a sentence a Bot is held to", () => {
  assert.deepEqual(typedRuleOptions("https://www.Example.com/path").map((option) => option.target), [{ kind: "site", host: "example.com" }]);
  assert.deepEqual(typedRuleOptions("book a flight").map((option) => option.target), [{ kind: "text", text: "book a flight" }]);
  assert.deepEqual(typedRuleOptions("  "), []);
});

test("Add rule: pick a tool, choose Block, and the rule is added for the whole Mac", async () => {
  const options: ApprovalRulePickerOption[] = [
    { target: { kind: "tool", tool: "browser_click" }, label: "Click on web pages", group: "Aiden" },
    { target: { kind: "connector", serverId: "gmail" }, label: "Gmail", group: "Connected apps" },
  ];
  const added: ApprovalRuleAddInput[] = [];
  let open = true;
  render(
    <AddApprovalRuleDialog
      open
      onOpenChange={(next) => { open = next; }}
      initialDecision={"allow" satisfies ApprovalRuleDecision}
      options={options}
      onAdd={async (input) => { added.push(input); }}
    />,
  );
  const confirm = () => screen.getByRole("button", { name: "Add rule" }) as HTMLButtonElement;
  assert.equal(confirm().disabled, true, "nothing is chosen yet");
  fireEvent.click(screen.getByText("Gmail"));
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Decision" })).getByRole("radio", { name: "Block" }));
  fireEvent.click(confirm());
  await waitFor(() => assert.equal(added.length, 1));
  assert.deepEqual(added[0], { target: { kind: "connector", serverId: "gmail" }, decision: "block", label: "Gmail" });
  await waitFor(() => assert.equal(open, false));
});

test("approval cards offer broader scopes only when the approval can be allowed", () => {
  assert.deepEqual(rememberableApprovalScopes(["always", "once", "chat"], true), ["chat", "always"]);
  assert.deepEqual(rememberableApprovalScopes(["once", "always", "bogus"], true), ["always"]);
  assert.deepEqual(rememberableApprovalScopes(["once", "chat", "always"], false), []);
  assert.deepEqual(rememberableApprovalScopes(undefined, true), []);
  assert.deepEqual(rememberableApprovalScopes(["once"], true), []);
  assert.deepEqual(
    (["once", "chat", "always"] as const).map(toolApprovalScopeLabel),
    ["Allow once", "Allow in this chat", "Allow in this workspace"],
  );
  assert.equal(
    describeToolApprovalRule({ toolName: "write_file", pattern: "out/report.txt" }),
    "Create or replace out/report.txt",
  );
});

test("a rules file that can't be read hides every rule, says what that means, and offers Try again or Start over", () => {
  const calls = view({ unreadable: true, rows: [ROWS[4]!], onRefresh: () => calls.push("refresh"), onSetAside: () => calls.push("set aside") });
  assert.match(screen.getByRole("alert").textContent ?? "", /every action asks first and Bots don’t act/u);
  assert.equal(screen.queryByRole("heading", { name: "Always allow" }), null);
  assert.equal(screen.queryByRole("heading", { name: "Blocked" }), null);
  assert.equal(screen.queryAllByRole("button", { name: /Add a rule/u }).length, 0, "nothing can be added over a file that can't be read");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  fireEvent.click(screen.getByRole("button", { name: "Start over" }));
  assert.deepEqual(calls, ["refresh", "set aside"]);
});

test("Block on a Bot's site allowance asks first, because it blocks the whole site", async () => {
  const calls = view();
  const site = screen.getByRole("radiogroup", { name: "Decision for calendar.example" });
  fireEvent.click(within(site).getByRole("radio", { name: "Block" }));
  assert.deepEqual(calls, [], "nothing changes before the person confirms");
  const dialog = await screen.findByRole("alertdialog");
  assert.match(dialog.textContent ?? "", /Ada will be blocked from every action on this site and its subdomains/u);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));
  assert.deepEqual(calls, []);

  fireEvent.click(within(site).getByRole("radio", { name: "Block" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Block site" }));
  assert.deepEqual(calls, ["decide calendar.example block"]);
  // Ask needs no warning: it narrows nothing.
  fireEvent.click(within(site).getByRole("radio", { name: "Ask" }));
  assert.deepEqual(calls, ["decide calendar.example block", "decide calendar.example ask"]);
});
