// Settings → Approvals → the rules page (docs/plans/bot-ux-simplification.md
// §3.5): every standing answer on this Mac in one place. Three groups, Always
// allow, Always ask and Blocked, each row with an Allow / Ask / Block control
// and Remove; then what the Mac itself allows (read and remove), links to the
// other places that hold trust, and the note that passwords, two-factor codes
// and money always come to the person.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, Lock, MoreHorizontal } from "lucide-react";
import {
  AlertDialog,
  Button,
  Callout,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldSet,
  Text,
  toast,
} from "../ui";
import { Segmented } from "../ui-primitives";
import { InfoHint } from "../ui-info-hint";
import { approvalRulesApi, onNotification } from "../../lib/ipc";
import { settingsLocation, type SettingsSection } from "../../lib/settings-section";
import { isUsable } from "../../lib/model-picker-data";
import { useProviders, useSettings } from "../../lib/queries";
import { effectiveApprovalMode, type ApprovalMode } from "../../shared/approval-mode";
import {
  APPROVAL_RULE_DECISION_LABELS,
  approvalRuleDecisionsFor,
  approvalRuleKindLabel,
  normalizeApprovalRuleHost,
  normalizeApprovalRuleText,
  type ApprovalRuleAddInput,
  type ApprovalRuleDecision,
  type ApprovalRulePickerOption,
  type ApprovalRuleRow,
  type ApprovalRuleRowGroup,
  type ApprovalRuleRowRef,
  type ApprovalRuleTarget,
} from "../../shared/approval-rules";

const GROUPS: ReadonlyArray<{ group: Exclude<ApprovalRuleRowGroup, "mac">; title: string; empty: string; decision: ApprovalRuleDecision }> = [
  { group: "allow", title: "Always allow", decision: "allow", empty: "Nothing yet. Choose Always on a card, or add a rule, to stop a question you keep answering." },
  { group: "ask", title: "Always ask", decision: "ask", empty: "Add a rule to be asked before something that would otherwise run." },
  { group: "block", title: "Blocked", decision: "block", empty: "Add a rule to stop something in every mode." },
];

/** A row's stable key, also the pending marker while it saves. */
export function approvalRuleRowKey(ref: ApprovalRuleRowRef): string {
  return JSON.stringify(ref);
}

function scopeText(row: ApprovalRuleRow): string {
  switch (row.scope.kind) {
    case "mac":
      return "Every Bot and workspace";
    case "workspace":
      return `Only in ${row.scope.label ?? "a workspace"}`;
    case "bot":
      return `Only for ${row.scope.label ?? "a Bot"}`;
    case "chat":
      return `${row.scope.label ?? "A Bot"} · one chat`;
  }
}

function addedText(createdAt: string | undefined): string {
  if (!createdAt) return "";
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? "" : ` · Added ${date.toLocaleDateString(undefined, { dateStyle: "medium" })}`;
}

export interface ApprovalRulesSettingsViewProps {
  /** `null` while the list loads. */
  rows: ApprovalRuleRow[] | null;
  error: string | null;
  /** The mode now: in Never ask only Block rules apply. */
  mode: ApprovalMode;
  /** The key of the row being saved, if any. */
  pending: string | null;
  onDecide(row: ApprovalRuleRow, decision: ApprovalRuleDecision): void;
  onHandOff(row: ApprovalRuleRow, on: boolean): void;
  onRemove(row: ApprovalRuleRow): void;
  onAdd(decision: ApprovalRuleDecision): void;
  onOpenSection(section: SettingsSection): void;
  onRetry(): void;
  /**
   * The rules file couldn't be read exactly. Its rules aren't shown; every
   * action asks and Bots don't act until it is read again or set aside.
   */
  unreadable?: boolean;
  /** Read the rules file again (after fixing it by hand). */
  onRefresh?(): void;
  /** Keep the unreadable file's bytes beside it and start with no rules. */
  onSetAside?(): void;
}

function RuleRow({ row, dimmed, pending, busy, onDecide, onHandOff, onRemove }: {
  row: ApprovalRuleRow;
  dimmed: boolean;
  pending: boolean;
  busy: boolean;
  onDecide(decision: ApprovalRuleDecision): void;
  onHandOff(on: boolean): void;
  onRemove(): void;
}) {
  const decision: ApprovalRuleDecision | undefined = row.group === "mac" ? undefined : row.group;
  return (
    <Field
      label={<span className="break-words">{row.title}</span>}
      description={`${row.kind} · ${scopeText(row)}${row.handOff?.on ? " · You do it yourself" : ""}${addedText(row.createdAt)}`}
      className={dimmed ? "opacity-55 transition-opacity duration-(--motion-duration) ease-standard" : undefined}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2" aria-busy={pending || undefined}>
        {decision && row.decisions.length > 1 ? (
          <Segmented
            aria-label={`Decision for ${row.title}`}
            value={decision}
            disabled={busy}
            onValueChange={(next) => { if (next !== decision) onDecide(next); }}
            options={row.decisions.map((value) => ({ value, label: APPROVAL_RULE_DECISION_LABELS[value] }))}
          />
        ) : null}
        {row.handOff ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="small" variant="transparent" iconOnly aria-label={`More for ${row.title}`} disabled={busy}>
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuCheckboxItem checked={row.handOff.on} onCheckedChange={(on) => onHandOff(on === true)}>
                Do it myself
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onRemove}>Remove</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button size="small" variant="transparent" disabled={busy} aria-label={`Remove: ${row.title}`} onClick={onRemove}>
            {pending ? "Removing…" : "Remove"}
          </Button>
        )}
      </div>
    </Field>
  );
}

const TRUST_LINKS: ReadonlyArray<{ section: SettingsSection; label: string; description: string }> = [
  { section: "hooks", label: "Hooks", description: "Commands you approved that can allow, ask or block before a tool runs." },
  { section: "remoteAccess", label: "Approved folders", description: "Folders paired phones and Macs may start work in." },
  { section: "remoteAccess", label: "Paired devices", description: "Phones and Macs that can answer approvals from afar." },
];

export function ApprovalRulesSettingsView(props: ApprovalRulesSettingsViewProps) {
  const { rows, error, mode, pending } = props;
  const busy = pending !== null;
  const never = mode === "never";
  /** A site allowance about to become a Block for every action on that site. */
  const [widening, setWidening] = React.useState<ApprovalRuleRow | null>(null);
  const row = (item: ApprovalRuleRow) => {
    const key = approvalRuleRowKey(item.ref);
    return (
      <RuleRow
        key={key}
        row={item}
        // A "Do it myself" rule still hands the step over in Never ask.
        dimmed={never && item.group !== "block" && item.group !== "mac" && item.handOff?.on !== true}
        pending={pending === key}
        busy={busy}
        onDecide={(decision) => {
          // A remembered action on one site becomes a Block for every action there: say so first.
          if (item.ref.source === "bot-allow" && item.kind === "Site" && decision === "block") setWidening(item);
          else props.onDecide(item, decision);
        }}
        onHandOff={(on) => props.onHandOff(item, on)}
        onRemove={() => props.onRemove(item)}
      />
    );
  };
  const macRows = rows?.filter((item) => item.group === "mac") ?? [];
  return (
    <>
      {rows === null ? (
        <FieldSet title="Rules">
          <Field>
            {error ? (
              <div className="flex flex-col items-start gap-2">
                <Callout color="red" role="alert">{error}</Callout>
                <Button size="small" variant="filled" onClick={props.onRetry}>Try again</Button>
              </div>
            ) : (
              <Text role="status" variant="small" color="secondary">Reading your rules…</Text>
            )}
          </Field>
        </FieldSet>
      ) : (
        <>
          {never ? (
            <Text as="p" variant="small" color="secondary" className="mb-3 px-4 text-pretty">
              In Never ask, only Block rules apply. The others take effect again in Ask and Auto.
            </Text>
          ) : null}
          {props.unreadable ? (
            <FieldSet title="Rules">
              <Field>
                <div className="flex flex-col items-start gap-3">
                  <Callout color="red" role="alert">
                    Your rules file couldn’t be read, so its rules aren’t shown. Until it can be, every action asks first and Bots don’t act.
                  </Callout>
                  <Text as="p" variant="small" color="secondary" className="text-pretty">
                    Fix approval-rules.json in Aiden’s data folder and try again, or start over. Starting over keeps the old file beside the new one.
                  </Text>
                  <div className="flex flex-wrap gap-2">
                    <Button size="small" variant="filled" disabled={busy} onClick={props.onRefresh}>Try again</Button>
                    <Button size="small" variant="transparent" disabled={busy} onClick={props.onSetAside}>Start over</Button>
                  </div>
                </div>
              </Field>
            </FieldSet>
          ) : null}
          {GROUPS.filter(() => !props.unreadable).map(({ group, title, empty, decision }) => {
            const items = rows.filter((item) => item.group === group);
            return (
              <FieldSet
                key={group}
                title={title}
                action={
                  <Button size="small" variant="transparent" disabled={busy} onClick={() => props.onAdd(decision)} aria-label={`Add a rule to ${title}`}>
                    Add rule
                  </Button>
                }
              >
                {items.length > 0 ? items.map(row) : (
                  <Field description={empty} className={never && group !== "block" ? "opacity-55" : undefined} />
                )}
              </FieldSet>
            );
          })}
          {macRows.length > 0 ? (
            <FieldSet
              title="Allowed on this Mac"
              hint={
                <InfoHint topic="Mac grants">
                  Commands, file changes and Computer Use you allowed for a workspace, a Bot or a chat. Remove one to be asked again.
                </InfoHint>
              }
            >
              {macRows.map(row)}
            </FieldSet>
          ) : null}
          {error ? <Callout color="red" role="alert" className="mb-7">{error}</Callout> : null}
        </>
      )}
      <FieldSet title="Also decides what runs">
        {TRUST_LINKS.map((link) => (
          <Field key={link.label} label={link.label} description={link.description}>
            <div className="flex justify-end">
              <Button size="small" variant="transparent" onClick={() => props.onOpenSection(link.section)} aria-label={`Open ${link.label}`}>
                Open
                <ChevronRight className="size-4" aria-hidden />
              </Button>
            </div>
          </Field>
        ))}
      </FieldSet>
      <Callout role="note" className="mb-7 flex-row items-start gap-3 p-4">
        <Lock className="mt-0.5 size-4 shrink-0 text-secondary" aria-hidden />
        <Text as="p" variant="small" color="secondary" className="text-pretty">
          Passwords, two-factor codes and money always come to you, in every mode. No rule can change that.
        </Text>
      </Callout>
      <AlertDialog
        open={widening !== null}
        onOpenChange={(open) => { if (!open) setWidening(null); }}
        title="Block the whole site?"
        description={widening
          ? `${widening.scope.label ?? "This Bot"} will be blocked from every action on this site and its subdomains, not only “${widening.title}”.`
          : undefined}
        confirmLabel="Block site"
        confirmVariant="destructive"
        onConfirm={() => {
          const target = widening;
          setWidening(null);
          if (!target) return;
          props.onDecide(target, "block");
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Add rule

/** The picker's options for what the person typed: a site, or a Bot rule in their words. */
export function typedRuleOptions(query: string): ApprovalRulePickerOption[] {
  const text = query.trim();
  if (!text) return [];
  const options: ApprovalRulePickerOption[] = [];
  const host = /\s/u.test(text) ? undefined : normalizeApprovalRuleHost(text);
  if (host) options.push({ target: { kind: "site", host }, label: host, group: "Site", description: "This site and its subdomains" });
  const words = normalizeApprovalRuleText(text);
  if (words && !host) {
    options.push({ target: { kind: "text", text: words }, label: `When a Bot wants to ${words}`, group: "In your words", description: "Bots match this against what they're about to do" });
  }
  return options;
}

function targetKey(target: ApprovalRuleTarget): string {
  return JSON.stringify(target);
}

export function AddApprovalRuleDialog({ open, onOpenChange, initialDecision, options, onAdd }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  initialDecision: ApprovalRuleDecision;
  /** `null` while loading. */
  options: ApprovalRulePickerOption[] | null;
  onAdd(input: ApprovalRuleAddInput): Promise<void>;
}) {
  const [query, setQuery] = React.useState("");
  const [chosen, setChosen] = React.useState<ApprovalRulePickerOption | null>(null);
  const [decision, setDecision] = React.useState<ApprovalRuleDecision>(initialDecision);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setChosen(null);
    setDecision(initialDecision);
  }, [open, initialDecision]);
  const typed = typedRuleOptions(query);
  const groups = new Map<string, ApprovalRulePickerOption[]>();
  for (const option of [...typed, ...(options ?? [])]) groups.set(option.group, [...(groups.get(option.group) ?? []), option]);
  const decisions = chosen ? approvalRuleDecisionsFor(chosen.target) : (["allow", "ask", "block"] as const);
  const effective = decisions.includes(decision) ? decision : decisions[0]!;
  const confirm = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await onAdd({ target: chosen.target, decision: effective, ...(chosen.target.kind === "tool" || chosen.target.kind === "connector" ? { label: chosen.label } : {}) });
      onOpenChange(false);
    } catch {
      // The caller says why; the dialog stays open to try again.
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add rule"
      description="Pick a tool, a connected app or a site, or describe what a Bot wants to do."
      confirmLabel="Add rule"
      confirmDisabled={!chosen}
      busy={busy}
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4">
        <Command shouldFilter label="Find what the rule is about" className="rounded-card bg-well">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search tools and apps, or type a site or a sentence"
            aria-label="Find what the rule is about"
          />
          <CommandList className="h-[min(240px,calc(100vh-18rem))]">
            {options === null ? <Text role="status" variant="small" color="secondary" className="px-3 py-6">Loading…</Text> : null}
            <CommandEmpty>Type a site like example.com, or what a Bot shouldn’t do.</CommandEmpty>
            {[...groups].map(([group, items]) => (
              <CommandGroup key={group} heading={group}>
                {items.map((option) => (
                  <CommandItem
                    key={targetKey(option.target)}
                    value={`${option.label} ${option.description ?? ""} ${targetKey(option.target)}`}
                    onSelect={() => setChosen(option)}
                    aria-selected={chosen !== null && targetKey(chosen.target) === targetKey(option.target)}
                    className={chosen !== null && targetKey(chosen.target) === targetKey(option.target) ? "bg-control" : undefined}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{option.label}</span>
                      {option.description ? <span className="truncate text-small text-secondary">{option.description}</span> : null}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
        {chosen ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Text as="p" variant="small" color="secondary" className="min-w-0 text-pretty">
              {approvalRuleKindLabel(chosen.target.kind)}: <span className="text-primary">{chosen.label}</span>
            </Text>
            <Segmented
              aria-label="Decision"
              value={effective}
              onValueChange={setDecision}
              options={decisions.map((value) => ({ value, label: APPROVAL_RULE_DECISION_LABELS[value] }))}
            />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Container

export function ApprovalRulesSettings() {
  const navigate = useNavigate();
  const settings = useSettings();
  const providers = useProviders();
  const mode = effectiveApprovalMode(settings.data, (providers.data ?? []).some(isUsable));
  const [rows, setRows] = React.useState<ApprovalRuleRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);
  const [unreadable, setUnreadable] = React.useState(false);
  const [adding, setAdding] = React.useState<ApprovalRuleDecision | null>(null);
  const [options, setOptions] = React.useState<ApprovalRulePickerOption[] | null>(null);

  const load = React.useCallback(async () => {
    try {
      const view = await approvalRulesApi.list();
      setRows(view.rows);
      setUnreadable(view.unreadable === true);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Aiden couldn’t read your rules.");
    }
  }, []);

  React.useEffect(() => {
    void load();
    const stopRules = approvalRulesApi.onChanged(() => void load());
    // Workspace grants and settings changes arrive on the shared controls channel.
    const stopControls = onNotification("settings:controls-changed", () => void load());
    return () => {
      stopRules();
      stopControls();
    };
  }, [load]);

  React.useEffect(() => {
    if (adding === null || options !== null) return;
    void approvalRulesApi.picker().then(setOptions, () => setOptions([]));
  }, [adding, options]);

  const run = async (row: ApprovalRuleRow, action: () => Promise<unknown>, failure: string) => {
    const key = approvalRuleRowKey(row.ref);
    setPending(key);
    try {
      await action();
      setError(null);
    } catch (actionError) {
      setError(actionError instanceof Error && actionError.message ? actionError.message : failure);
    } finally {
      setPending(null);
      await load();
    }
  };

  return (
    <>
      <ApprovalRulesSettingsView
        rows={rows}
        error={error}
        mode={mode}
        pending={pending}
        unreadable={unreadable}
        onRefresh={() => void run({ ref: { source: "rule", id: "unreadable" } } as ApprovalRuleRow, () => approvalRulesApi.refresh(), "Couldn’t read your rules.")}
        onSetAside={() => void run({ ref: { source: "rule", id: "unreadable" } } as ApprovalRuleRow, () => approvalRulesApi.setAside(), "Couldn’t start over.")}
        onDecide={(row, decision) => {
          // Show the move at once; the list read after saving settles it.
          setRows((current) => current?.map((item) => item === row ? { ...item, group: decision } : item) ?? null);
          void run(row, () => approvalRulesApi.change({ ref: row.ref, decision }), "Couldn’t change that rule.");
        }}
        onHandOff={(row, on) => void run(row, () => approvalRulesApi.change({ ref: row.ref, handOff: on }), "Couldn’t change that rule.")}
        onRemove={(row) => {
          setRows((current) => current?.filter((item) => item !== row) ?? null);
          void run(row, () => approvalRulesApi.remove(row.ref), "Couldn’t remove that rule.");
        }}
        onAdd={(decision) => setAdding(decision)}
        onOpenSection={(section) => void navigate({ ...settingsLocation(section), replace: true })}
        onRetry={() => void load()}
      />
      <AddApprovalRuleDialog
        open={adding !== null}
        onOpenChange={(open) => { if (!open) setAdding(null); }}
        initialDecision={adding ?? "allow"}
        options={options}
        onAdd={async (input) => {
          try {
            await approvalRulesApi.add(input);
            await load();
          } catch (addError) {
            toast.error(addError instanceof Error && addError.message ? addError.message : "Couldn’t add that rule.");
            throw addError;
          }
        }}
      />
    </>
  );
}
