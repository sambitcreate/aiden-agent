import { Badge } from "./ui";

/** The yellow "Needs you" mark on a Bot row, for this Mac's Bots and paired Macs' Bots alike. */
export function BotNeedsYouBadge() {
  return (
    <Badge color="warning" className="h-5 shrink-0 px-1.5 text-mini">
      Needs you
    </Badge>
  );
}
