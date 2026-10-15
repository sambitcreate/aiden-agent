import { PictureInPicture2 } from "lucide-react";
import { Button, Text } from "./ui";

/**
 * Stands in for a device tab while that device floats over the chat. The tab
 * never streams at the same time as the floating player.
 */
export function DeviceFloatingPlaceholder({ name, onDock }: { name: string; onDock(): void }) {
  return (
    <section aria-labelledby="device-floating-title" className="browser-empty h-full min-h-0">
      <PictureInPicture2 aria-hidden />
      <Text id="device-floating-title" variant="strong">
        {name} is floating over the chat
      </Text>
      <Button variant="muted" size="small" onClick={onDock}>
        Dock in this tab
      </Button>
    </section>
  );
}
