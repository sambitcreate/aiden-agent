// The pieces every approval card shares: the icon tile, Deny and Allow with
// their remembered-allow menu and shortcut hints, and the one line an answered
// or stale card collapses to (docs/design-guide.md, "Approval card").

import * as React from "react";
import { Check, ChevronDown, Clock, X, type LucideIcon } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Text,
} from "./ui";
import { cn } from "../lib/ui-utils";
import { LiveGuard } from "./live-guard";
import { approvalAriaKeyShortcut, approvalShortcutLabel, type ApprovalShortcut } from "../lib/approval-shortcuts";
import { detectedKeyboardPlatform } from "../shared/keybindings";
import { approvalStatusLabel, type ApprovalStatus } from "../shared/approval-card-model";

/** The accent squircle tile at the top of a card. */
export function ApprovalIconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="approval-icon-tile grid size-11 shrink-0 place-items-center bg-fill-accent text-fill-accent-foreground">
      <Icon className="size-5" aria-hidden="true" />
    </span>
  );
}

/** A broader allow in the chevron menu beside the primary Allow. */
export interface ApprovalRememberOption {
  key: string;
  label: string;
  /** One line on what it covers and where to undo it. */
  hint: string;
  onSelect(): void;
}

/**
 * Deny and Allow, the same on every approval card: two equal large buttons,
 * Deny the filled neutral action, Allow the accent one, joined with a chevron
 * menu when the card offers broader allows.
 */
export function ApprovalActions({
  denyRef,
  denyLabel = "Deny",
  onDeny,
  allowLabel,
  onAllow,
  allowDisabled = false,
  allowDescribedBy,
  rememberOptions = [],
  disabled,
  keyboardShortcuts = false,
}: {
  denyRef?: React.Ref<HTMLButtonElement>;
  denyLabel?: string;
  onDeny(): void;
  /** Absent: this card can only be denied here. */
  allowLabel?: string;
  onAllow?(): void;
  allowDisabled?: boolean;
  allowDescribedBy?: string;
  rememberOptions?: readonly ApprovalRememberOption[];
  disabled: boolean;
  /** Shows the ⌘⌫ and ⌘↩ hints on the buttons; the card owns the keys. */
  keyboardShortcuts?: boolean;
}) {
  const keyboardPlatform = detectedKeyboardPlatform();
  const shortcutHint = (shortcut: ApprovalShortcut) =>
    keyboardShortcuts && !disabled ? (
      // Shown only where both buttons have room for it; a narrow card keeps plain labels.
      <span aria-hidden="true" data-approval-shortcut={shortcut} className="ml-1.5 hidden shrink-0 font-normal tabular-nums opacity-65 @md:inline">
        {approvalShortcutLabel(shortcut, keyboardPlatform)}
      </span>
    ) : null;
  const joined = allowLabel !== undefined && rememberOptions.length > 0;
  return (
    <div className="@container mt-3.5 flex shrink-0 gap-2">
      <Button
        ref={denyRef}
        variant="filled"
        size="large"
        className="flex-1"
        disabled={disabled}
        aria-keyshortcuts={keyboardShortcuts ? approvalAriaKeyShortcut("deny", keyboardPlatform) : undefined}
        onClick={onDeny}
      >
        {denyLabel}
        {shortcutHint("deny")}
      </Button>
      {allowLabel !== undefined ? (
        <div className={cn("flex min-w-0 flex-1", joined && "squircle-action-group squircle-control shadow-control")}>
          <Button
            variant="accent"
            size="large"
            className={cn("min-w-0 flex-1", joined && "shadow-none hover:shadow-none active:shadow-none")}
            disabled={disabled || allowDisabled}
            aria-describedby={allowDescribedBy}
            aria-keyshortcuts={keyboardShortcuts ? approvalAriaKeyShortcut("allow", keyboardPlatform) : undefined}
            onClick={onAllow}
          >
            {allowLabel}
            {allowLabel === "Sending…" ? null : shortcutHint("allow")}
          </Button>
          {joined ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="accent"
                  size="large"
                  iconOnly
                  disabled={disabled || allowDisabled}
                  className="w-10 border-l border-fill-accent-foreground/25 shadow-none hover:shadow-none active:shadow-none"
                  aria-label="More ways to allow"
                  aria-describedby={allowDescribedBy}
                >
                  <ChevronDown aria-hidden="true" className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" className="w-80">
                {rememberOptions.map((option) => (
                  <DropdownMenuItem key={option.key} onSelect={option.onSelect} className="py-1.5">
                    <span className="flex min-w-0 flex-col">
                      <span>{option.label}</span>
                      <span className="text-small text-tertiary">{option.hint}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { approvalStatusLabel, type ApprovalStatus } from "../shared/approval-card-model";

/** An answered card, collapsed to one quiet line where the card was. */
export function ApprovalStatusLine({ status }: { status: ApprovalStatus }) {
  const Icon = status.decision === "allow" ? Check : status.decision === "deny" ? X : Clock;
  return (
    <div
      role="status"
      data-approval-status={status.decision}
      className="approval-shell composer-shell flex items-center justify-center gap-2 bg-popover px-4 py-2.5 shadow-composer"
    >
      <Icon
        aria-hidden="true"
        className={cn("size-4 shrink-0", status.decision === "allow" ? "text-status-green" : "text-tertiary")}
      />
      <Text variant="small" color="secondary" as="span">
        {approvalStatusLabel(status)}
      </Text>
    </div>
  );
}


/**
 * The ask card's frame for cards that are not tool approvals but ask the same
 * way (docs/plans/bot-ux-simplification.md §3.3): a Bot's folder or Mac
 * request, and the batch card that approves a plan. The tile, an optional
 * quiet line above the question, the question, the body, and Deny and Allow
 * at the foot. Aiden Live never presses anything in it.
 */
export function AskCard({
  label,
  tile,
  eyebrow,
  title,
  titleId,
  children,
  error,
  actions,
  className,
}: {
  /** The card's accessible name. */
  label: string;
  tile: React.ReactNode;
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  titleId?: string;
  children?: React.ReactNode;
  /** The last answer could not be sent. */
  error?: string | null;
  /** `ApprovalActions`, usually. */
  actions: React.ReactNode;
  className?: string;
}) {
  return (
    <LiveGuard guard="you" wrap={false}>
      <section
        data-live-guard="you"
        role="group"
        aria-label={label}
        className={cn(
          "approval-shell composer-shell min-h-0 overflow-y-auto overscroll-contain bg-popover p-4 shadow-composer [overflow-wrap:anywhere]",
          className,
        )}
      >
        <div className="flex shrink-0 flex-col items-center text-center">
          {tile}
          {eyebrow ? (
            <Text variant="small" color="tertiary" as="p" className="mt-2.5 text-balance">
              {eyebrow}
            </Text>
          ) : null}
          <Text variant="strong" as="p" id={titleId} className={cn(eyebrow ? "mt-0.5" : "mt-2.5", "text-balance")}>
            {title}
          </Text>
        </div>
        {children}
        {error ? (
          <Text variant="small" as="p" role="alert" className="mt-1.5 shrink-0 text-center text-status-red">
            {error}
          </Text>
        ) : null}
        {actions}
      </section>
    </LiveGuard>
  );
}
