// What a chat or Bot says about its spending limit, above its composer: a
// quiet line from 80% of the limit, and a notice with "Allow $X more" once it
// is reached. Status lives in the icon's soft fill, never in a border.

import { useNavigate } from "@tanstack/react-router";
import { CircleDollarSign } from "lucide-react";
import { Button, Text } from "../ui";
import { BotNoticeCard } from "../bots/bot-notice-card";
import { spendingNotice, type SpendingStatusView } from "../../shared/spending";

export function SpendingLimitNotice({
  status,
  name,
  allowing = false,
  onAllowMore,
  className,
}: {
  status: SpendingStatusView;
  /** The Bot's name; chats say "This chat". */
  name?: string;
  allowing?: boolean;
  onAllowMore(): void;
  className?: string;
}) {
  const navigate = useNavigate();
  const notice = spendingNotice(status, name);
  if (!notice) return null;
  if (status.state === "nearing") {
    return (
      <div className={className}>
        <Text as="p" variant="small" color="secondary" className="flex items-center gap-1.5 px-1 text-pretty">
          <CircleDollarSign aria-hidden="true" className="size-3.5 shrink-0 text-status-warning" />
          {notice.title}
        </Text>
      </div>
    );
  }
  return (
    <BotNoticeCard
      label="Spending limit reached"
      role="alert"
      icon={<CircleDollarSign />}
      iconTone="warning"
      title={notice.title}
      className={className}
      actions={
        <>
          <Button
            variant="transparent"
            size="small"
            onClick={() => void navigate({ to: "/settings", search: { section: "limits" } })}
          >
            Change limits
          </Button>
          <Button variant="filled" size="small" disabled={allowing} onClick={onAllowMore}>
            {notice.allowMoreLabel}
          </Button>
        </>
      }
    >
      <p>{notice.body}</p>
    </BotNoticeCard>
  );
}
