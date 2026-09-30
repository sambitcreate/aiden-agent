import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  describeToolApprovalRule,
  rememberableApprovalScopes,
  toolApprovalScopeLabel,
  type ToolApprovalRuleView,
} from "../../shared/tool-approval-scope.js";
import {
  ToolApprovalSettingsView,
  type ToolApprovalSettingsViewProps,
} from "./tool-approval-settings.js";

const noop = () => undefined;

const rules: ToolApprovalRuleView[] = [
  {
    id: "rule-1",
    toolName: "run_command",
    pattern: "npm run lint",
    workspaceId: "ws-1",
    workspaceLabel: "Aiden",
    createdAt: "2026-09-01T12:00:00.000Z",
  },
  {
    id: "rule-2",
    toolName: "edit_file",
    pattern: "docs/notes.md",
    workspaceId: "ws-2",
    createdAt: "2026-09-02T12:00:00.000Z",
  },
];

function render(extra: Partial<ToolApprovalSettingsViewProps> = {}): string {
  return renderToStaticMarkup(
    <ToolApprovalSettingsView
      rules={rules}
      error={null}
      pending={null}
      onRevoke={noop}
      onRevokeAll={noop}
      {...extra}
    />,
  );
}

function buttons(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>/gu)].map((match) => match[0]);
}

test("each always-allow rule shows exactly what it covers with its own revoke action", () => {
  const html = render();
  assert.match(html, /Run exactly: npm run lint/u);
  assert.match(html, /Edit docs\/notes\.md/u);
  assert.match(html, /Aiden · Added/u);
  assert.match(html, /Workspace · Added/u, "a rule without a captured label still names its scope");
  const labels = buttons(html).map((tag) => /aria-label="([^"]*)"/u.exec(tag)?.[1] ?? null);
  assert.deepEqual(labels, [
    "Revoke: Run exactly: npm run lint",
    "Revoke: Edit docs/notes.md",
    null,
  ]);
  assert.match(html, />Revoke all</u);
  assert.equal(buttons(html).some((tag) => / disabled=""/u.test(tag)), false);
});

test("a revoke in flight disables every action and names the busy row", () => {
  const html = render({ pending: "rule-2" });
  assert.equal(buttons(html).length, 3);
  assert.equal(buttons(html).every((tag) => / disabled=""/u.test(tag)), true);
  assert.equal((html.match(/Revoking…/gu) ?? []).length, 1);
});

test("empty, loading and failed states never offer a revoke action", () => {
  const empty = render({ rules: [] });
  assert.match(empty, /Nothing is always allowed/u);
  assert.equal(buttons(empty).length, 0);

  const loading = render({ rules: null });
  assert.match(loading, /role="status"[^>]*>Reading remembered approvals…/u);
  assert.equal(buttons(loading).length, 0);

  const failed = render({ rules: null, error: "Couldn’t read remembered approvals." });
  assert.match(failed, /role="alert"[^>]*>Couldn’t read remembered approvals\./u);
  assert.doesNotMatch(failed, /Reading remembered approvals/u);
  assert.equal(buttons(failed).length, 0);
});

test("approval cards offer broader scopes only when the approval can be allowed", () => {
  assert.deepEqual(rememberableApprovalScopes(["always", "once", "chat"], true), ["chat", "always"]);
  assert.deepEqual(rememberableApprovalScopes(["once", "always", "bogus"], true), ["always"]);
  assert.deepEqual(rememberableApprovalScopes(["once", "chat", "always"], false), []);
  assert.deepEqual(rememberableApprovalScopes(undefined, true), []);
  assert.deepEqual(rememberableApprovalScopes(["once"], true), []);
  assert.deepEqual(
    (["once", "chat", "always"] as const).map(toolApprovalScopeLabel),
    ["Allow once", "Allow for this chat", "Always allow"],
  );
  assert.equal(
    describeToolApprovalRule({ toolName: "write_file", pattern: "out/report.txt" }),
    "Create or replace out/report.txt",
  );
});
