import * as React from "react";
import { snoozeOptions } from "../../shared/chat-triage";
import { formatSnoozeUntil, type InboxTriageKind } from "../../lib/inbox-triage";
import type { ChatRowMenu } from "./chat-row";

type MenuParts = Parameters<ChatRowMenu>;

export interface InboxTriageMenuOptions {
  /** The row's chat is pinned, so the first item unpins it. */
  pinned: boolean;
  /** The host can't take writes right now (offline, connecting or blocked). */
  disabled: boolean;
  onAct: (kind: InboxTriageKind, until?: number) => void;
  /** The clock the presets count from, for tests. */
  now?: () => Date;
}

/**
 * The presets, worked out when the submenu opens so "1 hour" counts from then
 * and "This evening" drops out once it is 18:00.
 */
function SnoozeItems({
  Item,
  onSnooze,
  now,
}: {
  Item: MenuParts[0];
  onSnooze: (until: number) => void;
  now: () => Date;
}) {
  const [at] = React.useState(now);
  return (
    <>
      {snoozeOptions(at).map((option) => (
        <Item key={option.preset} data-snooze-preset={option.preset} onSelect={() => onSnooze(option.until)}>
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          <span className="ml-4 shrink-0 text-small text-tertiary">{formatSnoozeUntil(option.until, at.getTime())}</span>
        </Item>
      ))}
    </>
  );
}

/**
 * Pin (or Unpin), Mark done and Snooze for an Inbox row's ••• and context
 * menus. They never show as inline row buttons.
 */
export function inboxTriageMenuItems(
  [Item, , SubMenu]: MenuParts,
  { pinned, disabled, onAct, now = () => new Date() }: InboxTriageMenuOptions,
): React.ReactNode {
  return (
    <>
      <Item icon={pinned ? "pin-off" : "pin"} disabled={disabled} onSelect={() => onAct(pinned ? "unpin" : "pin")}>
        {pinned ? "Unpin" : "Pin"}
      </Item>
      <Item icon="circle-check" disabled={disabled} onSelect={() => onAct("done")}>
        Mark done
      </Item>
      <SubMenu.Sub>
        <SubMenu.Trigger icon="alarm-clock" disabled={disabled}>
          Snooze
        </SubMenu.Trigger>
        <SubMenu.Content className="min-w-56">
          <SnoozeItems Item={Item} now={now} onSnooze={(until) => onAct("snooze", until)} />
        </SubMenu.Content>
      </SubMenu.Sub>
    </>
  );
}
