import { BotStarterCarousel } from "../main/bots/bot-starter-carousel";
import type { BotDefinition } from "../shared/bots";
import { Button, Text } from "./ui";

/**
 * "Meet your first Bot" onboarding step: the shared starter carousel. Start chat
 * creates that starter Bot (its chat opens once onboarding finishes) and Skip
 * creates none; either way onboarding moves on. One line says what a Bot
 * hands back to the person (hand-offs) and that it follows their rules.
 */
export function OnboardingBotsStep({
  onStarted,
  onSkip,
}: {
  onStarted(bot: BotDefinition): void;
  onSkip(): void;
}) {
  return (
    <div className="max-w-2xl">
      <BotStarterCarousel onOpenChat={(bot) => onStarted(bot)} />
      <Text as="p" variant="small" color="secondary" className="mt-4 text-pretty">
        Bots hand you the steps only you should do, and follow rules you set.
      </Text>
      <div className="mt-4">
        <Button variant="transparent" onClick={onSkip}>
          Skip
        </Button>
      </div>
    </div>
  );
}
