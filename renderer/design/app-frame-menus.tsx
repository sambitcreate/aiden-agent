// A live app frame's header menus with design live on (design mode v2 Phase
// 3c): the device menu, which shows the viewport and changes it to a device
// size or a typed one (S92), and is the keyboard's way to resize a frame.

import { MonitorSmartphone } from "lucide-react";
import * as React from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../components/ui";
import { returnFocus } from "../lib/focus-return";
import { APP_DEVICE_NAMES, APP_DEVICES, isAppDevice, type AppDevice } from "../shared/design-canvas/app-devices";
import { APP_DEFAULT_VIEWPORT, APP_FRAME_LIMITS, isAppViewportSide } from "../shared/design-canvas/app-frame";
import type { DesignFrame } from "../shared/design-canvas/schema";

export type AppViewportSize = { width: number; height: number };

/** The device whose size the viewport is exactly, if any. */
export function deviceOf(viewport: AppViewportSize): AppDevice | undefined {
  return APP_DEVICE_NAMES.find((name) => APP_DEVICES[name].width === viewport.width && APP_DEVICES[name].height === viewport.height);
}

const RANGE = `${APP_FRAME_LIMITS.minViewport}–${APP_FRAME_LIMITS.maxViewport}`;

/** A typed side: whole digits only, in the viewport's range. */
function typedSide(value: string): number | null {
  if (!/^\d{1,4}$/u.test(value.trim())) return null;
  const side = Number(value.trim());
  return isAppViewportSide(side) ? side : null;
}

/**
 * Width and Height fields for a typed size, with Apply and Cancel. Apply stays
 * off until both are whole numbers in range; a field out of range says the range.
 */
export function AppViewportFields({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: AppViewportSize;
  submitLabel: string;
  onSubmit(size: AppViewportSize): void;
  onCancel(): void;
}) {
  const id = React.useId();
  const [width, setWidth] = React.useState(String(initial.width));
  const [height, setHeight] = React.useState(String(initial.height));
  const w = typedSide(width);
  const h = typedSide(height);
  const field = (name: "Width" | "Height", value: string, set: (value: string) => void, valid: boolean) => (
    <label className="flex flex-col gap-1 text-small text-secondary" htmlFor={`${id}-${name}`}>
      {name}
      <Input
        id={`${id}-${name}`}
        inputMode="numeric"
        autoComplete="off"
        value={value}
        aria-invalid={valid ? undefined : true}
        aria-describedby={valid ? undefined : `${id}-${name}-help`}
        onChange={(event) => set(event.target.value)}
        className="w-24 tabular-nums"
      />
      {valid ? null : (
        <span id={`${id}-${name}-help`} className="text-small text-status-red">
          {RANGE}
        </span>
      )}
    </label>
  );
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (w !== null && h !== null) onSubmit({ width: w, height: h });
      }}
    >
      <div className="flex gap-3">
        {field("Width", width, setWidth, w !== null)}
        {field("Height", height, setHeight, h !== null)}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="small" variant="muted" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="small" disabled={w === null || h === null}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * The device button: it names the frame's device, or its size, and opens the
 * four device sizes plus Custom…, a popover for a typed width and height. A
 * change keeps the frame's scale (S92).
 */
export function AppDeviceMenu({
  frame,
  compact = false,
  onViewport,
}: {
  frame: DesignFrame;
  /** A narrow frame shows the button as an icon only. */
  compact?: boolean;
  onViewport(viewport: AppViewportSize): void;
}) {
  const viewport = frame.viewport ?? APP_DEFAULT_VIEWPORT;
  const device = deviceOf(viewport);
  const size = `${viewport.width} × ${viewport.height}`;
  const spoken = `Viewport, ${device ? `${APP_DEVICES[device].label}, ` : ""}${viewport.width} by ${viewport.height}`;
  const trigger = React.useRef<HTMLButtonElement | null>(null);
  // Set when Custom… is chosen, so the closing menu leaves focus to the popover.
  const opening = React.useRef(false);
  const [custom, setCustom] = React.useState(false);
  const close = () => setCustom(false);
  return (
    <Popover open={custom} onOpenChange={(open) => (open ? undefined : close())}>
      <DropdownMenu>
        <PopoverAnchor asChild>
          <DropdownMenuTrigger asChild>
            <Button
              ref={trigger}
              size="small"
              variant="transparent"
              iconOnly={compact}
              aria-label={spoken}
              title="Viewport"
              disabled={frame.locked === true}
              className={compact ? undefined : "tabular-nums"}
            >
              {compact ? <MonitorSmartphone aria-hidden /> : device ? APP_DEVICES[device].label : size}
            </Button>
          </DropdownMenuTrigger>
        </PopoverAnchor>
        <DropdownMenuContent
          align="end"
          className="min-w-48"
          onCloseAutoFocus={(event) => {
            if (!opening.current) return;
            opening.current = false;
            event.preventDefault();
          }}
        >
          <DropdownMenuLabel>Viewport</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={device ?? ""}
            onValueChange={(value) => {
              if (isAppDevice(value)) onViewport({ width: APP_DEVICES[value].width, height: APP_DEVICES[value].height });
            }}
          >
            {APP_DEVICE_NAMES.map((name) => (
              <DropdownMenuRadioItem key={name} value={name}>
                <span className="flex-1">{APP_DEVICES[name].label}</span>
                <span className="ml-4 text-secondary tabular-nums">{`${APP_DEVICES[name].width} × ${APP_DEVICES[name].height}`}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              opening.current = true;
              setCustom(true);
            }}
          >
            Custom…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PopoverContent
        role="dialog"
        aria-label="Custom viewport"
        align="end"
        className="w-auto p-3"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus([trigger.current]);
        }}
      >
        {custom ? (
          <AppViewportFields
            initial={viewport}
            submitLabel="Apply"
            onCancel={close}
            onSubmit={(next) => {
              close();
              onViewport(next);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
