import { PanelsLeftRight } from "lucide-react";
import { Button, Callout } from "./ui";

/** Shown in design mode while the window is too narrow for the chat and canvas side by side. */
export function DesignModeBanner({ onWiden }: { onWiden(): void }) {
  return (
    <Callout color="warning" role="status" className="flex-row items-center gap-3 py-2 pl-3 pr-2 shadow-dialog">
      <PanelsLeftRight className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-small">Design mode needs a wider window</span>
      <Button variant="filled" size="small" onClick={onWiden}>
        Widen window
      </Button>
    </Callout>
  );
}
