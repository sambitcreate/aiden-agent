import * as React from "react";
import { Button, Callout, Field, FieldSet, Text, toast } from "../ui";
import { chatsApi } from "../../lib/ipc";
import {
  describeToolApprovalRule,
  type ToolApprovalRuleView,
} from "../../shared/tool-approval-scope";

export interface ToolApprovalSettingsViewProps {
  /** `null` while the list is loading. */
  rules: ToolApprovalRuleView[] | null;
  error: string | null;
  /** Rule id being revoked, `"all"` while revoking everything, or null. */
  pending: string | null;
  onRevoke: (id: string) => void;
  onRevokeAll: () => void;
}

function workspaceLine(rule: ToolApprovalRuleView): string {
  const created = new Date(rule.createdAt);
  const when = Number.isNaN(created.getTime())
    ? ""
    : ` · Added ${created.toLocaleDateString(undefined, { dateStyle: "medium" })}`;
  return `${rule.workspaceLabel ?? "Workspace"}${when}`;
}

export function ToolApprovalSettingsView({
  rules,
  error,
  pending,
  onRevoke,
  onRevokeAll,
}: ToolApprovalSettingsViewProps) {
  const busy = pending !== null;
  return (
    <>
      <FieldSet title="Always allowed">
        {rules === null ? (
          <Field>
            {error ? (
              <Callout color="red" role="alert">
                {error}
              </Callout>
            ) : (
              <Text role="status" variant="small" color="secondary">
                Reading remembered approvals…
              </Text>
            )}
          </Field>
        ) : rules.length === 0 ? (
          <Field
            label="Nothing is always allowed"
            description="When Aiden asks before running a command or changing a file, choose Always allow to skip that exact request next time in the same workspace."
          />
        ) : (
          rules.map((rule) => (
            <Field
              key={rule.id}
              label={
                <span className="font-mono break-all select-text">
                  {describeToolApprovalRule(rule)}
                </span>
              }
              description={workspaceLine(rule)}
            >
              <Button
                size="small"
                variant="transparent"
                disabled={busy}
                aria-label={`Revoke: ${describeToolApprovalRule(rule)}`}
                onClick={() => onRevoke(rule.id)}
              >
                {pending === rule.id ? "Revoking…" : "Revoke"}
              </Button>
            </Field>
          ))
        )}
        {rules && rules.length > 0 ? (
          <Field
            label="Revoke all"
            description="Aiden will ask again before every command and file change in workspaces that use Ask."
          >
            <Button size="small" variant="destructive" disabled={busy} onClick={onRevokeAll}>
              {pending === "all" ? "Revoking…" : "Revoke all"}
            </Button>
          </Field>
        ) : null}
      </FieldSet>
      {rules && error ? (
        <Callout color="red" role="alert" className="mb-7">
          {error}
        </Callout>
      ) : null}
      <Text as="p" variant="small" color="secondary" className="mb-7">
        Rules match only the exact command or the exact file path you approved, in the workspace
        where you approved it. Allow for this chat lasts until the app quits and never appears
        here. Rules stay on this device.
      </Text>
    </>
  );
}

export function ToolApprovalSettings() {
  const [rules, setRules] = React.useState<ToolApprovalRuleView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setRules(await chatsApi.listApprovalRules());
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Couldn’t read remembered approvals.",
      );
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const run = React.useCallback(
    async (key: string, action: () => Promise<unknown>, success: string) => {
      setPending(key);
      try {
        await action();
        toast.success(success);
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : "Couldn’t revoke that rule.");
      } finally {
        setPending(null);
        await load();
      }
    },
    [load],
  );

  return (
    <ToolApprovalSettingsView
      rules={rules}
      error={error}
      pending={pending}
      onRevoke={(id) =>
        void run(id, () => chatsApi.revokeApprovalRule(id), "Aiden will ask again for that action.")
      }
      onRevokeAll={() =>
        void run("all", () => chatsApi.revokeAllApprovalRules(), "All remembered approvals revoked.")
      }
    />
  );
}
