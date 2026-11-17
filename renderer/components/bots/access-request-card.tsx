// A Bot's request to use a folder or the whole Mac, drawn as an ask card
// (docs/plans/bot-ux-simplification.md §3.3): Deny and Allow once, with
// "Always for this folder" in the menu beside Allow when the request offers
// it. Whole-Mac access is only ever Allow once or Deny. The answers are the
// same as before: Deny is `not_now`, Allow once `once`, Always `always`.

import { FolderOpen, Laptop } from "lucide-react";
import { BotAvatar } from "../bot-avatar";
import { AskCard, ApprovalActions, type ApprovalRememberOption } from "../approval-card-parts";
import { DEFAULT_BOT_AVATAR, type BotAvatar as BotAvatarValue } from "../../shared/bots";
import { botAccessCardTitle, type BotAccessChoice, type BotPendingAccessRequest } from "../../shared/bot-access-requests";

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
  const title = botAccessCardTitle(botName, request);
  const remember: ApprovalRememberOption[] = request.choices.includes("always")
    ? [
        {
          key: "always",
          label: "Always for this folder",
          hint: `${botName} can use this folder from now on. Remove it in Settings → Approvals.`,
          onSelect: () => onAnswer("always"),
        },
      ]
    : [];
  return (
    <AskCard
      label={title}
      tile={<BotAvatar botId={request.botId} photoLoading="immediate" avatar={avatar} name={botName} size="large" />}
      title={
        <span className="inline-flex max-w-full items-center gap-1.5">
          <Icon aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
          {title}
        </span>
      }
      actions={
        <ApprovalActions
          onDeny={() => onAnswer("not_now")}
          {...(request.choices.includes("once") ? { allowLabel: "Allow once", onAllow: () => onAnswer("once") } : {})}
          rememberOptions={remember}
          disabled={busy}
        />
      }
    >
      <div className="mt-2.5 text-center text-small text-secondary">
        {request.target === "folder" && request.place ? <p className="text-tertiary">{request.place}</p> : null}
        <p className="whitespace-pre-line">{request.why}</p>
        {request.target === "folder" && request.approvalCount !== undefined ? (
          <p className="mt-1 text-tertiary">{`You’ve allowed this folder ${request.approvalCount} times in the last 2 weeks.`}</p>
        ) : null}
      </div>
    </AskCard>
  );
}
