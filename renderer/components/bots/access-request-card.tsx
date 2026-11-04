import { FolderOpen, Laptop } from "lucide-react";
import { BotAvatar } from "../bot-avatar";
import { Button } from "../ui";
import { BotNoticeCard } from "./bot-notice-card";
import { DEFAULT_BOT_AVATAR, type BotAvatar as BotAvatarValue } from "../../shared/bots";
import { botAccessCardTitle, type BotAccessChoice, type BotPendingAccessRequest } from "../../shared/bot-access-requests";

const CHOICE_LABELS: Record<BotAccessChoice, string> = {
  not_now: "Not now",
  always: "Always for this folder",
  once: "Allow once",
};

export function AccessRequestCard({
  request,
  botName = "This Bot",
  avatar = DEFAULT_BOT_AVATAR,
  busy,
  onAnswer,
}: {
  request: BotPendingAccessRequest;
  botName?: string;
  avatar?: BotAvatarValue;
  busy: boolean;
  onAnswer(choice: BotAccessChoice): void;
}) {
  const Icon = request.target === "folder" ? FolderOpen : Laptop;
  return (
    <BotNoticeCard
      label={botAccessCardTitle(botName, request)}
      elevated
      iconTile={<BotAvatar botId={request.botId} photoLoading="immediate" avatar={avatar} name={botName} size="small" />}
      title={
        <span className="inline-flex max-w-full items-center gap-1.5 [overflow-wrap:anywhere]">
          <Icon aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
          {botAccessCardTitle(botName, request)}
        </span>
      }
      actions={request.choices.map((choice, index) => (
        <Button
          key={choice}
          variant={index === request.choices.length - 1 ? "accent" : "transparent"}
          size="small"
          disabled={busy}
          onClick={() => onAnswer(choice)}
        >
          {CHOICE_LABELS[choice]}
        </Button>
      ))}
    >
      {request.target === "folder" && request.place ? <p className="text-tertiary">{request.place}</p> : null}
      <p className="whitespace-pre-line">{request.why}</p>
    </BotNoticeCard>
  );
}
