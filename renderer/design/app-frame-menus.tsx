// A live app frame's header menus with design live on (design mode v2 Phase
// 3c): the device menu, which shows the viewport and changes it to a device
// size or a typed one (S92), and is the keyboard's way to resize a frame; and
// More (S93, S96, S98): Add view at width, Duplicate page as variant, Move
// page file to Trash… (confirmed in a popover first) and Remove from canvas.

import { Ellipsis, MonitorSmartphone } from "lucide-react";
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../components/ui";
import { returnFocus } from "../lib/focus-return";
import { ariaKeyShortcut, prettyAccelerator } from "../shared/keybindings";
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
  // Set when Custom… is chosen. The popover opens only once the menu has
  // closed: opened beside the modal menu, the menu's focus trap would take
  // focus back and the popover would dismiss itself as focus left it.
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
            setCustom(true);
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

/** A view's size: a device, or a typed width and height. */
export type AppViewSize = { device: AppDevice } | AppViewportSize;

/**
 * More, at the end of a live app frame's header. Custom… and the Trash
 * confirmation open in a popover on the button, so focus goes back to it;
 * the Trash asks first, with focus on Cancel (the design guide's
 * destructive-but-restorable rule: no modal). `folded` holds what a narrow
 * frame's header has no room for (its Dark switch and Download).
 */
export function AppMoreMenu({
  frame,
  onAddView,
  onDuplicate,
  onTrash,
  onRemove,
  folded,
}: {
  frame: DesignFrame;
  onAddView(size: AppViewSize): void;
  onDuplicate(): void;
  onTrash(): void;
  onRemove(): void;
  folded?: React.ReactNode;
}) {
  const name = frame.title || "frame";
  const locked = frame.locked === true;
  const trigger = React.useRef<HTMLButtonElement | null>(null);
  const cancel = React.useRef<HTMLButtonElement | null>(null);
  // The layer chosen in the menu, opened once the menu has closed (as in the device menu).
  const opening = React.useRef<"custom" | "trash" | null>(null);
  // A confirmed Trash hands focus to the canvas (so ⌘Z undoes it at once), not back to More.
  const confirmed = React.useRef(false);
  const [layer, setLayer] = React.useState<"custom" | "trash" | null>(null);
  const close = () => setLayer(null);
  const open = (next: "custom" | "trash") => {
    opening.current = next;
  };
  const route = frame.route ?? "/";
  const textId = React.useId();
  return (
    <Popover open={layer !== null} onOpenChange={(next) => (next ? undefined : close())}>
      <DropdownMenu>
        <PopoverAnchor asChild>
          <DropdownMenuTrigger asChild>
            <Button ref={trigger} iconOnly size="small" variant="transparent" aria-label={`More actions for ${name}`} title="More">
              <Ellipsis aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </PopoverAnchor>
        <DropdownMenuContent
          align="end"
          className="min-w-56"
          onCloseAutoFocus={(event) => {
            const next = opening.current;
            if (!next) return;
            opening.current = null;
            event.preventDefault();
            setLayer(next);
          }}
        >
          {folded}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={locked}>Add view at width</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-48">
              {APP_DEVICE_NAMES.map((device) => (
                <DropdownMenuItem key={device} onSelect={() => onAddView({ device })}>
                  <span className="flex-1">{APP_DEVICES[device].label}</span>
                  <span className="ml-4 text-secondary tabular-nums">{`${APP_DEVICES[device].width} × ${APP_DEVICES[device].height}`}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => open("custom")}>Custom…</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem disabled={locked} aria-keyshortcuts={ariaKeyShortcut("Command+D")} onSelect={onDuplicate}>
            <span className="flex-1">Duplicate page as variant</span>
            <span aria-hidden className="text-tertiary">
              {prettyAccelerator("Command+D")}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={locked} color="status-red" onSelect={() => open("trash")}>
            Move page file to Trash…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={locked} aria-keyshortcuts="Backspace" onSelect={onRemove}>
            <span className="flex-1">Remove from canvas</span>
            <span aria-hidden className="text-tertiary">
              {prettyAccelerator("Backspace")}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PopoverContent
        role={layer === "trash" ? "alertdialog" : "dialog"}
        aria-label={layer === "trash" ? "Move page file to Trash" : "Add view at width"}
        aria-describedby={layer === "trash" ? textId : undefined}
        align="end"
        className={layer === "trash" ? "w-72 p-3" : "w-auto p-3"}
        onOpenAutoFocus={(event) => {
          if (layer !== "trash") return;
          event.preventDefault();
          cancel.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (confirmed.current) {
            confirmed.current = false;
            return;
          }
          returnFocus([trigger.current]);
        }}
      >
        {layer === "custom" ? (
          <AppViewportFields
            initial={frame.viewport ?? APP_DEFAULT_VIEWPORT}
            submitLabel="Add view"
            onCancel={close}
            onSubmit={(size) => {
              close();
              onAddView(size);
            }}
          />
        ) : layer === "trash" ? (
          <div className="flex flex-col gap-3">
            <p id={textId} className="text-regular text-primary">
              {`The file that serves ${route} goes to the Trash, and its frames leave the canvas. You can undo this.`}
            </p>
            <div className="flex justify-end gap-2">
              <Button ref={cancel} type="button" size="small" variant="muted" onClick={close}>
                Cancel
              </Button>
              <Button
                type="button"
                size="small"
                variant="destructive"
                onClick={() => {
                  confirmed.current = true;
                  close();
                  onTrash();
                }}
              >
                Move to Trash
              </Button>
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
