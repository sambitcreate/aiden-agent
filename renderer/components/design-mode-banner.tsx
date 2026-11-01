import { PanelsLeftRight, X } from "lucide-react";
import { Button, Callout } from "./ui";

/**
 * Shown in design mode while the content is too narrow for the chat and canvas
 * side by side, and only when widening the window can work.
 */
export function DesignModeBanner({ onWiden, onDismiss }: { onWiden(): void; onDismiss(): void }) {
  return (
    <Callout color="warning" role="status" className="flex-row items-center gap-3 py-2 pl-3 pr-2 shadow-dialog">
      <PanelsLeftRight className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-small">Design mode needs a wider window</span>
      <Button variant="filled" size="small" onClick={onWiden}>
        Widen window
      </Button>
      <Button iconOnly variant="transparent" size="small" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
        <X />
      </Button>
    </Callout>
  );
}
