import * as React from "react";
import { browserApi } from "../lib/ipc";
import { Button, toast } from "./ui";

export type BrowserMenuOption = {
  label: string;
  checked?: boolean;
  disabled?: boolean;
  select?: (shiftKey: boolean) => void;
} | null;

/** Electron draws this menu above the native guest. The button still belongs to the renderer's focus order. */
export function BrowserMenuButton({ scope, options, children, ...props }: React.ComponentProps<typeof Button> & {
  scope: string;
  options: BrowserMenuOption[];
}) {
  const request = React.useRef<string | null>(null);
  const [open, setOpen] = React.useState(false);
  React.useLayoutEffect(() => {
    setOpen(false);
    return () => {
      const id = request.current;
      request.current = null;
      if (id) void browserApi.dismissMenu(id).catch(() => {});
    };
  }, [scope]);

  const show = async (button: HTMLButtonElement) => {
    if (request.current) return;
    const id = crypto.randomUUID();
    request.current = id;
    setOpen(true);
    button.focus();
    const rect = button.getBoundingClientRect();
    try {
      const choice = await browserApi.popupMenu(id, { x: rect.left, y: rect.bottom }, options.map((item) =>
        item && { label: item.label, enabled: Boolean(item.select) && !item.disabled, checked: item.checked }));
      if (request.current !== id || !choice || button.closest("[inert], [hidden]") || !button.isConnected) return;
      const option = options[choice.index];
      if (option && !option.disabled) option.select?.(choice.shiftKey);
    } catch {
      if (request.current === id) toast.error("Could not open the browser menu.");
    } finally {
      if (request.current === id) {
        request.current = null;
        setOpen(false);
      }
    }
  };
  return <Button variant="transparent" size="small" {...props} aria-haspopup="menu" aria-expanded={open}
    onClick={(event) => void show(event.currentTarget)}
    onKeyDown={(event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); void show(event.currentTarget); }
    }}>{children}</Button>;
}
