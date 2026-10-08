import { BotStarterCarousel } from "../main/bots/bot-starter-carousel";
import type { BotDefinition } from "../shared/bots";
import { Button } from "./ui";

/**
 * "Meet Your First Bot" onboarding step: the shared starter carousel. Start Chat
 * creates that starter Bot (its chat opens once onboarding finishes) and Skip
 * creates none; either way onboarding moves on.
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
      <div className="mt-4">
        <Button variant="transparent" onClick={onSkip}>
          Skip
        </Button>
      </div>
    </div>
  );
}
