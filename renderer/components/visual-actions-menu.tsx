import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui";

/** One more thing the person can do with an inline visual, from its caption's menu. */
export interface VisualMenuAction {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
}

/**
 * A visual caption's trailing action. With no extra actions it is the visual's
 * own button (Copy as text, Export); with some, that button becomes an
 * Actions menu that lists the visual's own action first, so the caption never
 * grows another always-visible control.
 */
export function VisualCaptionActions({
  title,
  primary,
  extras,
}: {
  title: string;
  primary: { ariaLabel: string; menuLabel: string; icon: LucideIcon; onSelect: () => void; disabled?: boolean };
  extras?: readonly VisualMenuAction[] | undefined;
}) {
  const PrimaryIcon = primary.icon;
  if (!extras?.length) {
    return (
      <Button iconOnly size="small" variant="transparent" aria-label={primary.ariaLabel} disabled={primary.disabled} onClick={primary.onSelect}>
        <PrimaryIcon aria-hidden="true" />
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button iconOnly size="small" variant="transparent" aria-label={`Actions for ${title}`}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem disabled={primary.disabled} onSelect={primary.onSelect}>
          <PrimaryIcon aria-hidden="true" />
          {primary.menuLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {extras.map((action) => {
          const Icon = action.icon;
          return (
            <DropdownMenuItem key={action.key} disabled={action.disabled} onSelect={action.onSelect}>
              <Icon aria-hidden="true" />
              {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
