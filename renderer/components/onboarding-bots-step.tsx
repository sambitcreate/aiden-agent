import { BotStarterCarousel } from "../main/bots/bot-starter-carousel";
import type { BotDefinition } from "../shared/bots";
import { Button, Text } from "./ui";

/**
 * "Meet your first Bot" onboarding step: the shared starter carousel. Start chat
 * creates that starter Bot (its chat opens once onboarding finishes) and Skip
 * creates none; either way onboarding moves on. One line says what a Bot
 * hands back to the person (hand-offs), rules, and whole-plan approval.
 */
export function OnboardingBotsStep({
  onStarted,
  onSkip,
  onBusyChange,
  busy,
}: {
  onStarted(bot: BotDefinition): void;
  onSkip(): void;
  busy?: boolean;
  onBusyChange?(busy: boolean): void;
}) {
  return (
    <div className="max-w-2xl">
      <BotStarterCarousel onBusyChange={onBusyChange} onOpenChat={(bot) => onStarted(bot)} />
      <Text as="p" variant="small" color="secondary" className="mt-4 text-pretty">
        Bots track accepted tasks in Open work, follow your rules, hand you the steps only you should do, and can ask you to approve a whole plan.
      </Text>
      <Text as="p" variant="small" color="secondary" className="mt-2 text-pretty">
        Bots can message each other when it helps; turn it off in Settings → Bots & Approvals.
      </Text>
      <div className="mt-4">
        <Button variant="transparent" disabled={busy} onClick={onSkip}>
          Skip
        </Button>
      </div>
    </div>
  );
}
