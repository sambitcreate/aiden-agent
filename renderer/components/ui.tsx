import * as React from "react";
import {
  AlertDialog as AlertDialogPrimitive,
  ContextMenu as ContextMenuPrimitive,
  Dialog as DialogPrimitive,
  DropdownMenu as DropdownMenuPrimitive,
  HoverCard as HoverCardPrimitive,
  Label as LabelPrimitive,
  Popover as PopoverPrimitive,
  RadioGroup as RadioGroupPrimitive,
  Select as SelectPrimitive,
  Separator as SeparatorPrimitive,
  Slot,
  Switch as SwitchPrimitive,
  Tooltip as TooltipPrimitive,
} from "radix-ui";
import { Command as CommandPrimitive } from "cmdk";
import { createPortal } from "react-dom";
import { ArrowDownToLine, PanelLeft, Check, ChevronDown, Search } from "lucide-react";
import { Toaster as SonnerToaster, toast } from "sonner";
import { reportRendererDiagnostic } from "../lib/dev-log";
import { cn } from "../lib/ui-utils";
import { useCommandHandler, useShortcutBinding, useShortcutLabel } from "../lib/command-system";
import {
  compactSidebarAutoFocusIntent,
  type CompactSidebarAutoFocusIntent,
  type CompactSidebarFocusState,
} from "../lib/compact-sidebar-focus";
import { ariaKeyShortcut } from "../shared/keybindings";

export { toast };
export function Toaster(props: React.ComponentProps<typeof SonnerToaster>) {
  return <SonnerToaster position="top-center" offset={52} richColors {...props} />;
}
export const TooltipProvider = TooltipPrimitive.Provider;

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?:
    | "filled"
    | "muted"
    | "transparent"
    | "glass"
    | "toolbar"
    | "glassAccent"
    | "accent"
    | "destructive";
  size?: "small" | "medium" | "large";
  iconOnly?: boolean;
  radius?: "full" | "rounded";
  asChild?: boolean;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "filled",
    size = "medium",
    iconOnly,
    radius = "full",
    asChild,
    type = "button",
    ...props
  },
  ref,
) {
  const Component = asChild ? Slot.Root : "button";
  return (
    <Component
      ref={ref}
      type={asChild ? undefined : type}
      data-slot="button"
      className={cn(
        "dimmable inline-flex shrink-0 cursor-default items-center justify-center whitespace-nowrap border-0 text-strong outline-none transition-[background-color,color,box-shadow,opacity,transform] duration-150 ease-out active:scale-[0.985] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45 motion-reduce:transform-none [&_svg:not([class*='size-'])]:size-4",
        radius === "full" ? "rounded-pill" : "rounded-control",
        size === "small" && "h-7 gap-1.5 px-2",
        size === "medium" && "h-8 gap-1.5 px-3 [&_svg:not([class*='size-'])]:size-4.5",
        size === "large" && "h-9 gap-1.5 px-3 [&_svg:not([class*='size-'])]:size-5",
        iconOnly && "aspect-square px-0",
        variant === "filled" &&
          "bg-control text-primary shadow-control hover:bg-control-hover hover:shadow-control-hover active:bg-control-active active:shadow-control-pressed focus-visible:bg-control-active",
        variant === "muted" &&
          "bg-control/50 text-primary hover:bg-control active:bg-control-hover active:shadow-control-pressed focus-visible:bg-control",
        variant === "transparent" &&
          "bg-transparent text-primary hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection",
        variant === "glass" &&
          "glass-surface text-primary shadow-control hover:bg-control/70 hover:shadow-control-hover active:bg-control-active active:shadow-control-pressed focus-visible:bg-control-active",
        variant === "toolbar" &&
          "glass-surface text-toolbar-icon shadow-control hover:bg-control/70 hover:shadow-control-hover active:bg-control-active active:shadow-control-pressed focus-visible:bg-control-active",
        variant === "glassAccent" &&
          "bg-accent text-accent-foreground shadow-control hover:bg-accent-hover hover:shadow-control-hover active:bg-accent-active active:shadow-control-pressed focus-visible:bg-accent-hover",
        variant === "accent" &&
          "bg-accent text-accent-foreground shadow-control hover:bg-accent-hover hover:shadow-control-hover active:bg-accent-active active:shadow-control-pressed focus-visible:bg-accent-hover",
        variant === "destructive" &&
          "bg-red text-red-foreground shadow-control hover:bg-red hover:shadow-control-hover active:bg-red active:shadow-control-pressed focus-visible:bg-red",
        className,
      )}
      {...props}
    />
  );
});

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-8 w-full rounded-control border border-field bg-transparent px-3 text-regular text-primary outline-none transition-[background-color,border-color,box-shadow,opacity] duration-150 ease-out placeholder:text-secondary hover:border-primary/30 focus:bg-input disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-red",
        className,
      )}
      {...props}
    />
  );
});

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  density?: "default" | "compact";
};

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, density = "default", ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "field-sizing-content w-full resize-none rounded-control border border-field bg-transparent px-3 py-2 text-regular text-primary outline-none transition-[background-color,border-color,box-shadow,opacity] duration-150 ease-out placeholder:text-secondary hover:border-primary/30 focus:bg-input disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-red",
        density === "compact" ? "min-h-7" : "min-h-16",
        className,
      )}
      {...props}
    />
  );
});

type TextProps = React.HTMLAttributes<HTMLElement> & {
  as?: keyof React.JSX.IntrinsicElements;
  variant?: "heading1" | "strong" | "regular" | "small" | "small-strong";
  color?: "primary" | "secondary" | "tertiary" | "quaternary" | "red";
  truncate?: boolean;
};

export function Text({
  as = "span",
  variant = "regular",
  color = "primary",
  truncate,
  className,
  ...props
}: TextProps) {
  const Component = as as React.ElementType;
  return (
    <Component
      className={cn(
        variant === "heading1" && "text-heading1 font-semibold",
        variant === "strong" && "text-strong font-medium",
        variant === "regular" && "text-regular",
        variant === "small" && "text-small",
        variant === "small-strong" && "text-small-strong font-medium",
        color === "primary" && "text-primary",
        color === "secondary" && "text-secondary",
        color === "tertiary" && "text-tertiary",
        color === "quaternary" && "text-quaternary",
        color === "red" && "text-red",
        truncate && "truncate",
        className,
      )}
      {...props}
    />
  );
}

export function InlineMetadata({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("text-mini text-tertiary", className)} {...props} />;
}

export function Badge({
  color = "gray",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { color?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-pill bg-control px-2 text-small-strong",
        color === "green" && "border-green/30 bg-green/10 text-green",
        color === "red" && "border-red/30 bg-red/10 text-red",
        color === "blue" && "border-accent/30 bg-accent/10 text-accent",
        className,
      )}
      {...props}
    />
  );
}

export function Callout({
  color,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { color?: string }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 break-words rounded-card bg-well p-3",
        color === "red" && "border-red/25 bg-red/5",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyState({
  title,
  description,
  placement,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  placement?: "inline";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-10 text-center",
        placement === "inline" && "py-6",
        className,
      )}
    >
      <Text variant="strong">{title}</Text>
      {description ? (
        <Text variant="small" color="secondary" className="mt-1 max-w-sm">
          {description}
        </Text>
      ) : null}
    </div>
  );
}

export function Status({
  variant,
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: "error" }) {
  return (
    <span
      className={cn(
        "rounded-pill border border-field bg-popover px-2 py-1 text-small-strong",
        variant === "error" && "text-red",
        className,
      )}
      {...props}
    />
  );
}

export const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(function Separator({ className, orientation = "horizontal", ...props }, ref) {
  return (
    <SeparatorPrimitive.Root
      ref={ref}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-separator",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
});

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(function Label({ className, ...props }, ref) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn("inline-flex items-center gap-2 text-regular text-primary", className)}
      {...props}
    />
  );
});

export function FieldSet({
  title,
  className,
  children,
}: React.PropsWithChildren<{ title?: React.ReactNode; className?: string }>) {
  return (
    <section className={cn("mb-7", className)}>
      {title ? <h2 className="mb-3 px-4 text-large-strong text-primary">{title}</h2> : null}
      <div className="overflow-hidden rounded-card bg-well">{children}</div>
    </section>
  );
}

export function Field({
  label,
  description,
  orientation = "horizontal",
  className,
  children,
}: React.PropsWithChildren<{
  label?: React.ReactNode;
  description?: React.ReactNode;
  orientation?: "horizontal" | "vertical";
  className?: string;
}>) {
  const labelId = React.useId();
  const descriptionId = React.useId();
  return (
    <div
      role={label ? "group" : undefined}
      aria-labelledby={label ? labelId : undefined}
      aria-describedby={description ? descriptionId : undefined}
      className={cn(
        "relative p-4 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden",
        orientation === "horizontal"
          ? "settings-field-horizontal grid min-h-12 grid-cols-[minmax(120px,0.8fr)_minmax(160px,1.2fr)] items-center gap-5 max-[540px]:grid-cols-1 max-[540px]:items-start max-[540px]:gap-2"
          : "flex flex-col gap-3",
        className,
      )}
    >
      <div className="min-w-0">
        {label ? (
          <div id={labelId} className="text-strong text-primary">
            {label}
          </div>
        ) : null}
        {description ? (
          <div id={descriptionId} className="mt-0.5 max-w-[34rem] text-small text-secondary">
            {description}
          </div>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export const FieldGroup = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={className} {...props} />
);
export const FieldContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={className} {...props} />
);
export const FieldLabel = Label;

const SplitContext = React.createContext<{
  collapsed: boolean;
  toggle: () => void;
  leadingAnchor: HTMLDivElement | null;
} | null>(null);

type SplitViewProps = React.PropsWithChildren<{
  sidebar: React.ReactNode;
  storageKey: string;
  sidebarSize?: { default: number; min: number; max: number };
  contentModalOpen?: boolean;
}>;

function SplitViewRoot({
  sidebar,
  storageKey,
  sidebarSize,
  contentModalOpen = false,
  children,
}: SplitViewProps) {
  const collapseKey = `${storageKey}.sidebar-collapsed`;
  const widthKey = `${storageKey}.sidebar-width`;
  const limits = sidebarSize ?? { default: 260, min: 220, max: 340 };
  const [collapsed, setCollapsed] = React.useState(
    () => window.innerWidth < 700 || localStorage.getItem(collapseKey) === "1",
  );
  const [viewportWidth, setViewportWidth] = React.useState(() => window.innerWidth);
  const compact = viewportWidth < 700;
  const [width, setWidth] = React.useState(() => {
    const saved = Number(localStorage.getItem(widthKey));
    return Number.isFinite(saved) && saved >= limits.min && saved <= limits.max
      ? saved
      : limits.default;
  });
  const [leadingAnchor, setLeadingAnchor] = React.useState<HTMLDivElement | null>(null);
  const sidebarRef = React.useRef<HTMLElement>(null);
  const contentModalOpenRef = React.useRef(contentModalOpen);
  const previousCompactSidebarFocusStateRef = React.useRef<CompactSidebarFocusState>({
    compact,
    expanded: !collapsed,
    contentModalOpen,
  });
  const compactSidebarFocusIntentRef = React.useRef<CompactSidebarAutoFocusIntent | null>(null);
  React.useLayoutEffect(() => {
    contentModalOpenRef.current = contentModalOpen;
  }, [contentModalOpen]);
  React.useLayoutEffect(() => {
    const next: CompactSidebarFocusState = {
      compact,
      expanded: !collapsed,
      contentModalOpen,
    };
    compactSidebarFocusIntentRef.current = compactSidebarAutoFocusIntent(
      previousCompactSidebarFocusStateRef.current,
      next,
    );
    previousCompactSidebarFocusStateRef.current = next;
  }, [collapsed, compact, contentModalOpen]);
  const toggle = React.useCallback(() => {
    const next = !collapsed;
    localStorage.setItem(collapseKey, next ? "1" : "0");
    setCollapsed(next);
  }, [collapseKey, collapsed]);
  useCommandHandler("sidebar.toggle", toggle, !contentModalOpen);

  React.useEffect(() => {
    let wasCompact = window.innerWidth < 700;
    if (wasCompact) setCollapsed(true);
    const onResize = () => {
      const nextWidth = window.innerWidth;
      const nextCompact = nextWidth < 700;
      setViewportWidth(nextWidth);
      if (nextCompact && !wasCompact) setCollapsed(true);
      wasCompact = nextCompact;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const beginResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const move = (moveEvent: PointerEvent) => {
        setWidth(
          Math.min(limits.max, Math.max(limits.min, startWidth + moveEvent.clientX - startX)),
        );
      };
      const finish = (upEvent: PointerEvent) => {
        const next = Math.min(
          limits.max,
          Math.max(limits.min, startWidth + upEvent.clientX - startX),
        );
        setWidth(next);
        localStorage.setItem(widthKey, String(Math.round(next)));
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
    },
    [collapsed, limits.max, limits.min, width, widthKey],
  );

  const resizeWithKeyboard = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const increment = event.shiftKey ? 40 : 16;
      let next = width;
      if (event.key === "ArrowLeft") next = width - increment;
      else if (event.key === "ArrowRight") next = width + increment;
      else if (event.key === "Home") next = limits.min;
      else if (event.key === "End") next = limits.max;
      else return;

      event.preventDefault();
      next = Math.min(limits.max, Math.max(limits.min, next));
      setWidth(next);
      localStorage.setItem(widthKey, String(Math.round(next)));
    },
    [limits.max, limits.min, width, widthKey],
  );

  const compactOpen = compact && !collapsed && !contentModalOpen;
  const renderedSidebarWidth = collapsed
    ? 0
    : compact
      ? Math.min(width, viewportWidth - 56)
      : width;
  const reservedSidebarWidth = !compact && !collapsed ? width : 0;

  React.useEffect(() => {
    if (!compactOpen) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector =
      "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])";
    const getFocusable = () =>
      [
        ...Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []),
        ...Array.from(leadingAnchor?.querySelectorAll<HTMLElement>(focusableSelector) ?? []),
      ].filter((element) => element.offsetParent !== null);
    const frame =
      compactSidebarFocusIntentRef.current === "first-control"
        ? requestAnimationFrame(() => {
            if (!leadingAnchor?.contains(previousFocus)) getFocusable()[0]?.focus();
          })
        : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (document.querySelector('[data-slot="dialog-content"][data-state="open"]')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        localStorage.setItem(collapseKey, "1");
        setCollapsed(true);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !focusable.includes(active as HTMLElement))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !focusable.includes(active as HTMLElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      if (!contentModalOpenRef.current && previousFocus?.isConnected)
        requestAnimationFrame(() => previousFocus.focus());
    };
  }, [collapseKey, compactOpen, leadingAnchor]);

  return (
    <SplitContext.Provider value={{ collapsed, toggle, leadingAnchor }}>
      <div className="relative flex h-screen min-h-0 w-full overflow-hidden text-primary">
        {compactOpen ? (
          <button
            type="button"
            aria-label="Close sidebar"
            onClick={toggle}
            tabIndex={-1}
            className="absolute inset-0 z-20 cursor-default bg-black/10 outline-none backdrop-blur-[1px] transition-opacity"
          />
        ) : null}
        <aside
          ref={sidebarRef}
          inert={collapsed || contentModalOpen ? true : undefined}
          aria-hidden={collapsed || contentModalOpen ? true : undefined}
          className={cn(
            "absolute inset-y-0 left-0 z-10 h-full overflow-hidden bg-sidebar transition-[width,opacity] duration-300 ease-out motion-reduce:transition-none",
            compact && !collapsed && "z-30 shadow-dialog",
          )}
          style={{
            width: renderedSidebarWidth,
            opacity: collapsed ? 0 : 1,
            pointerEvents: collapsed || contentModalOpen ? "none" : "auto",
          }}
        >
          <div
            style={{ width: compact ? Math.min(width, viewportWidth - 56) : width }}
            className="h-full"
          >
            {sidebar}
          </div>
        </aside>
        <div
          aria-hidden="true"
          className="h-full shrink-0 transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: reservedSidebarWidth }}
        />
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={limits.min}
          aria-valuemax={limits.max}
          aria-valuenow={Math.round(width)}
          tabIndex={collapsed || compact || contentModalOpen ? -1 : 0}
          onPointerDown={beginResize}
          onKeyDown={resizeWithKeyboard}
          className={cn(
            "relative z-20 -mx-[3px] w-[7px] shrink-0 cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-[3px] before:w-px before:bg-separator hover:before:bg-primary/20 focus-visible:before:w-0.5 focus-visible:before:bg-accent",
            (collapsed || compact || contentModalOpen) && "pointer-events-none opacity-0",
          )}
        />
        <main
          inert={compactOpen ? true : undefined}
          aria-hidden={compactOpen ? true : undefined}
          className="min-w-0 flex-1 bg-background"
        >
          {children}
        </main>
        <div
          ref={setLeadingAnchor}
          inert={contentModalOpen ? true : undefined}
          aria-hidden={contentModalOpen ? true : undefined}
          className={cn(
            "absolute left-[90px] top-0 z-40 flex h-13 w-9 items-center justify-center",
            contentModalOpen && "pointer-events-none",
          )}
        />
      </div>
    </SplitContext.Provider>
  );
}

function SidebarToggle() {
  const context = React.useContext(SplitContext);
  const shortcut = useShortcutLabel("sidebar.toggle");
  const shortcutBinding = useShortcutBinding("sidebar.toggle");
  if (!context) return null;
  const button = (
    <Button
      iconOnly
      size={context.collapsed ? "large" : "small"}
      variant={context.collapsed ? "toolbar" : "transparent"}
      onClick={context.toggle}
      aria-label={context.collapsed ? "Show sidebar" : "Hide sidebar"}
      aria-keyshortcuts={ariaKeyShortcut(shortcutBinding)}
      aria-pressed={!context.collapsed}
      title={`Toggle sidebar (${shortcut})`}
      className="no-drag transition-[width,height,background-color] duration-300 motion-reduce:transition-none"
    >
      <PanelLeft />
    </Button>
  );
  return context.leadingAnchor ? createPortal(button, context.leadingAnchor) : null;
}

export const SplitView = Object.assign(SplitViewRoot, { SidebarToggle });

export function Sidebar({
  searchable,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  actions,
  footer,
  children,
}: React.PropsWithChildren<{
  searchable?: boolean;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
}>) {
  const viewport = React.useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = React.useState(true);
  const [atBottom, setAtBottom] = React.useState(true);
  const updateScrollEdges = React.useCallback((element = viewport.current) => {
    if (!element) return;
    setAtTop(element.scrollTop < 2);
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 2);
  }, []);

  React.useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => updateScrollEdges(element);
    const frame = requestAnimationFrame(update);
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(element);
    const observeChildren = () => {
      for (const child of element.children) {
        if (child instanceof HTMLElement) resizeObserver.observe(child);
      }
    };
    observeChildren();
    const mutationObserver = new MutationObserver(() => {
      observeChildren();
      update();
    });
    mutationObserver.observe(element, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [updateScrollEdges]);

  return (
    <div
      data-sidebar
      className="glass-surface relative flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div className="drag-region flex h-13 shrink-0 items-center justify-end px-3">{actions}</div>
      {searchable ? (
        <div className="px-3 pb-3">
          <label className="flex h-8 items-center gap-2 rounded-pill border border-transparent bg-input px-2.5 transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:bg-control/70 focus-within:bg-control">
            <Search className="size-4 shrink-0 text-tertiary" />
            <input
              type="search"
              value={searchValue}
              onChange={(event) => onSearchChange?.(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && searchValue) {
                  event.preventDefault();
                  event.stopPropagation();
                  onSearchChange?.("");
                  event.currentTarget.blur();
                }
              }}
              placeholder={searchPlaceholder ?? "Search"}
              aria-label={searchPlaceholder ?? "Search"}
              className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-primary outline-none placeholder:text-tertiary"
            />
          </label>
        </div>
      ) : null}
      <div
        ref={viewport}
        data-scroll-top={atTop}
        data-scroll-bottom={atBottom}
        className="scroll-edge-mask dimmable min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => updateScrollEdges(event.currentTarget)}
      >
        {children}
      </div>
      {footer}
    </div>
  );
}

export const SidebarFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "relative shrink-0 px-2 pb-2 before:pointer-events-none before:absolute before:inset-x-0 before:-top-10 before:h-10 before:bg-gradient-to-t before:from-sidebar before:to-transparent",
      className,
    )}
    {...props}
  />
);
export const SidebarList = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col px-2.5 pb-3", className)} {...props} />
);
export function SidebarListGroup({
  title,
  className,
  children,
}: React.PropsWithChildren<{ title?: React.ReactNode; className?: string }>) {
  return (
    <div className={cn("mt-5 first:mt-0", className)}>
      {title ? (
        <div className="mb-1.5 px-2.5 text-[13px] font-medium text-tertiary">{title}</div>
      ) : null}
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}
export function SidebarListItem({
  icon,
  title,
  trailing,
  selected,
  className,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title"> & {
  icon?: React.ReactNode;
  title: React.ReactNode;
  trailing?: React.ReactNode;
  selected?: boolean;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      className={cn(
        "flex min-h-9 w-full cursor-default items-center gap-2.5 rounded-[11px] px-2.5 py-1.5 text-left text-[14px] text-primary outline-none transition-[background-color] duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none",
        selected && "bg-list-selection hover:bg-list-selection focus-visible:bg-list-selection",
        className,
      )}
      {...props}
    >
      {icon ? (
        <span className="flex shrink-0 text-secondary [&_svg:not([class*='size-'])]:size-4.5">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {trailing !== undefined && trailing !== null ? (
        <span className="flex shrink-0 items-center">{trailing}</span>
      ) : null}
    </button>
  );
}

export function ScrollArea({
  title,
  leading,
  actions,
  toolbar,
  footer,
  autoScrollToBottom,
  autoScrollDeps = [],
  showScrollToBottomButton,
  scrollToBottomButtonOffset = 0,
  className,
  children,
}: React.PropsWithChildren<{
  title?: React.ReactNode;
  leading?: React.ReactNode;
  actions?: React.ReactNode;
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
  autoScrollToBottom?: boolean;
  autoScrollDeps?: unknown[];
  showScrollToBottomButton?: boolean;
  scrollToBottomButtonOffset?: number;
  className?: string;
}>) {
  const viewport = React.useRef<HTMLDivElement>(null);
  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const footerRef = React.useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = React.useState(0);
  const [footerHeight, setFooterHeight] = React.useState(0);
  const footerHeightRef = React.useRef(0);
  const [atBottom, setAtBottom] = React.useState(true);
  const [atScrollEnd, setAtScrollEnd] = React.useState(true);
  const [atTop, setAtTop] = React.useState(true);
  const atBottomRef = React.useRef(true);
  const split = React.useContext(SplitContext);

  atBottomRef.current = atBottom;

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = viewport.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
    setAtBottom(true);
    setAtScrollEnd(true);
    setAtTop(element.scrollHeight <= element.clientHeight);
  }, []);

  const updateScrollEdges = React.useCallback((element = viewport.current) => {
    if (!element) return;
    setAtTop(element.scrollTop < 2);
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    setAtBottom(remaining < 24);
    setAtScrollEnd(remaining < 2);
  }, []);

  React.useLayoutEffect(() => {
    const measure = () => {
      setToolbarHeight(toolbarRef.current?.getBoundingClientRect().height ?? 0);
      const nextFooterHeight = footerRef.current?.getBoundingClientRect().height ?? 0;
      if (nextFooterHeight !== footerHeightRef.current) {
        footerHeightRef.current = nextFooterHeight;
        setFooterHeight(nextFooterHeight);
        if (atBottomRef.current) requestAnimationFrame(() => scrollToBottom("auto"));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (toolbarRef.current) observer.observe(toolbarRef.current);
    if (footerRef.current) observer.observe(footerRef.current);
    return () => observer.disconnect();
  }, [toolbar, footer, title, leading, actions, scrollToBottom]);

  React.useEffect(() => {
    if (autoScrollToBottom && atBottom) scrollToBottom("auto");
  }, [autoScrollToBottom, ...autoScrollDeps]);

  React.useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => {
      if (autoScrollToBottom && atBottomRef.current) scrollToBottom("auto");
      else updateScrollEdges(element);
    };
    // Settle synchronously first so the viewport never paints at scrollTop 0 and
    // then jumps; the frame after still catches late layout (fonts, images).
    update();
    const frame = requestAnimationFrame(update);
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(element);
    const observeChildren = () => {
      for (const child of element.children) {
        if (child instanceof HTMLElement) resizeObserver.observe(child);
      }
    };
    observeChildren();
    const mutationObserver = new MutationObserver(() => {
      observeChildren();
      update();
    });
    mutationObserver.observe(element, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [autoScrollToBottom, scrollToBottom, updateScrollEdges]);

  const resolvedToolbar =
    toolbar ??
    (title || leading || actions ? (
      <header
        data-toolbar
        className="scroll-area-header drag-region relative flex min-h-13 items-center gap-3 px-4 transition-[padding] duration-300 ease-out motion-reduce:transition-none"
        style={{ paddingLeft: split?.collapsed ? 142 : undefined }}
      >
        <div className="no-drag flex shrink-0 items-center">{leading}</div>
        <h1 className="min-w-0 flex-1 truncate text-strong text-primary">{title}</h1>
        <div className="no-drag flex items-center gap-2">{actions}</div>
      </header>
    ) : null);

  return (
    <div className={cn("relative isolate h-full min-h-0 overflow-hidden bg-background", className)}>
      {resolvedToolbar ? (
        <div ref={toolbarRef} className="absolute inset-x-0 top-0 z-30">
          {resolvedToolbar}
        </div>
      ) : null}
      <div
        ref={viewport}
        data-scroll-top={atTop}
        data-scroll-bottom={atScrollEnd}
        className="scroll-edge-mask relative z-0 h-full w-full overflow-y-auto overscroll-contain"
        style={{ paddingTop: toolbarHeight, paddingBottom: footerHeight }}
        onScroll={(event) => {
          updateScrollEdges(event.currentTarget);
        }}
      >
        {children}
      </div>
      {showScrollToBottomButton && !atBottom ? (
        <Button
          iconOnly
          size="medium"
          variant="filled"
          onClick={() => scrollToBottom()}
          aria-label="Scroll to bottom"
          className="absolute left-1/2 z-20 -translate-x-1/2 bg-popover/95 shadow-popover hover:bg-popover"
          style={{ bottom: footerHeight + 12 + Math.max(0, scrollToBottomButtonOffset) }}
        >
          <ArrowDownToLine />
        </Button>
      ) : null}
      {footer ? (
        <div ref={footerRef} className="absolute inset-x-0 bottom-0 z-10">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

export type DialogLayer = "default" | "onboarding";

type DialogProps = React.PropsWithChildren<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  confirmHidden?: boolean;
  cancelRef?: React.RefObject<HTMLButtonElement | null>;
  dismissDisabled?: boolean;
  cancelDisabled?: boolean;
  busy?: boolean;
  onConfirm?: () => void | Promise<void>;
  returnFocus?: () => HTMLElement | null;
  size?: "large";
  layer?: DialogLayer;
}>;

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Done",
  confirmDisabled,
  confirmHidden,
  cancelRef,
  dismissDisabled,
  cancelDisabled,
  busy,
  onConfirm,
  returnFocus,
  size,
  layer = "default",
  children,
}: DialogProps) {
  const dismissBlocked = Boolean(dismissDisabled || cancelDisabled || busy);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen || !dismissBlocked) onOpenChange(nextOpen);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="dialog-overlay"
          className={cn("fixed inset-0 bg-transparent", layer === "onboarding" ? "z-[70]" : "z-50")}
        />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          aria-busy={busy || undefined}
          onCloseAutoFocus={(event) => {
            const target = returnFocus?.();
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
          onEscapeKeyDown={(event) => dismissBlocked && event.preventDefault()}
          onPointerDownOutside={(event) => dismissBlocked && event.preventDefault()}
          className={cn(
            "fixed left-1/2 top-1/2 flex max-h-[85vh] w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-dialog bg-popover px-6 py-5 outline-none",
            layer === "onboarding" ? "z-[70] shadow-onboarding" : "z-50 shadow-modal",
            size === "large" && "w-[min(92vw,680px)]",
          )}
        >
          <DialogPrimitive.Title className="shrink-0 text-heading2 font-semibold">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description asChild>
              <div className="mt-1.5 shrink-0 text-regular text-secondary">{description}</div>
            </DialogPrimitive.Description>
          ) : null}
          <div className="mt-4 min-h-0 overflow-y-auto px-0.5">{children}</div>
          <div className="mt-5 flex shrink-0 justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <Button ref={cancelRef} variant="filled" disabled={dismissBlocked}>
                {confirmHidden ? "Close" : "Cancel"}
              </Button>
            </DialogPrimitive.Close>
            {confirmHidden ? null : (
              <Button
                variant="accent"
                disabled={confirmDisabled || busy}
                onClick={() => void onConfirm?.()}
              >
                {confirmLabel}
              </Button>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  confirmVariant,
  busy = false,
  keepOpenOnConfirm = false,
  returnFocus,
  onConfirm,
  layer = "default",
}: Omit<
  DialogProps,
  | "children"
  | "size"
  | "confirmDisabled"
  | "confirmHidden"
  | "cancelRef"
  | "dismissDisabled"
  | "cancelDisabled"
  | "busy"
  | "description"
> & {
  description?: React.ReactNode;
  confirmVariant?: "destructive";
  busy?: boolean;
  keepOpenOnConfirm?: boolean;
}) {
  const confirm = (
    <Button
      variant={confirmVariant === "destructive" ? "destructive" : "accent"}
      disabled={busy}
      onClick={() => void onConfirm?.()}
    >
      {confirmLabel}
    </Button>
  );
  return (
    <AlertDialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay
          data-slot="dialog-overlay"
          className={cn("fixed inset-0 bg-transparent", layer === "onboarding" ? "z-[70]" : "z-50")}
        />
        <AlertDialogPrimitive.Content
          data-slot="dialog-content"
          aria-busy={busy}
          onCloseAutoFocus={(event) => {
            const target =
              returnFocus?.() ?? document.querySelector<HTMLElement>("[data-app-focus-root]");
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
          onEscapeKeyDown={(event) => busy && event.preventDefault()}
          className={cn(
            "fixed left-1/2 top-1/2 w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded-dialog bg-popover px-6 py-5 outline-none",
            layer === "onboarding" ? "z-[70] shadow-onboarding" : "z-50 shadow-modal",
          )}
        >
          <AlertDialogPrimitive.Title className="text-heading2 font-semibold">
            {title}
          </AlertDialogPrimitive.Title>
          {description ? (
            <AlertDialogPrimitive.Description asChild>
              <div className="mt-2 text-regular text-secondary">{description}</div>
            </AlertDialogPrimitive.Description>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="filled" disabled={busy}>
                Cancel
              </Button>
            </AlertDialogPrimitive.Cancel>
            {keepOpenOnConfirm ? (
              confirm
            ) : (
              <AlertDialogPrimitive.Action asChild>{confirm}</AlertDialogPrimitive.Action>
            )}
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}

const menuContentClass =
  "z-50 min-w-48 overflow-hidden rounded-popover bg-popover p-1 text-primary shadow-popover outline-none";
const menuItemClass =
  "relative flex min-h-7 cursor-default select-none items-center gap-2 rounded-lg px-2 py-1 text-regular outline-none transition-colors duration-150 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-45";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(function Content({ className, sideOffset = 6, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        data-slot="popover-content"
        sideOffset={sideOffset}
        className={cn(
          menuContentClass,
          "origin-[var(--radix-dropdown-menu-content-transform-origin)]",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});
export const DropdownMenuLabel = ({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>) => (
  <DropdownMenuPrimitive.Label
    className={cn("px-2 py-1.5 text-small-strong text-tertiary", className)}
    {...props}
  />
);
export const DropdownMenuSeparator = ({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>) => (
  <DropdownMenuPrimitive.Separator className={cn("my-1 h-px bg-separator", className)} {...props} />
);
export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    icon?: string;
    color?: string;
  }
>(function Item({ className, icon: _icon, color, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(menuItemClass, color === "red" && "text-red", className)}
      {...props}
    />
  );
});
export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem> & { sublabel?: string }
>(function CheckboxItem({ className, children, sublabel, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn(menuItemClass, "group pl-7", className)}
      {...props}
    >
      <span className="absolute left-2">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-3.5" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      <span className="flex min-w-0 flex-col">
        <span>{children}</span>
        {sublabel ? (
          <span className="max-w-72 text-small text-tertiary group-data-[highlighted]:text-accent-foreground">
            {sublabel}
          </span>
        ) : null}
      </span>
    </DropdownMenuPrimitive.CheckboxItem>
  );
});

export const CustomDropdownMenu = DropdownMenuPrimitive.Root;
export const CustomDropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const CustomDropdownMenuContent = DropdownMenuContent;

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        data-slot="popover-content"
        sideOffset={sideOffset}
        className={cn(
          menuContentClass,
          "origin-[var(--radix-popover-content-transform-origin)]",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});

export const HoverCard = HoverCardPrimitive.Root;
export const HoverCardTrigger = HoverCardPrimitive.Trigger;
export const HoverCardContent = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(function HoverCardContent({ className, sideOffset = 8, ...props }, ref) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        ref={ref}
        data-slot="popover-content"
        sideOffset={sideOffset}
        className={cn(
          "z-[60] w-64 rounded-popover bg-popover p-3 text-primary shadow-popover outline-none",
          "origin-[var(--radix-hover-card-content-transform-origin)]",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
});

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(function ContextContent({ className, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        ref={ref}
        data-slot="popover-content"
        className={cn(
          menuContentClass,
          "origin-[var(--radix-context-menu-content-transform-origin)]",
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
});
export const ContextMenuSeparator = ({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>) => (
  <ContextMenuPrimitive.Separator className={cn("my-1 h-px bg-separator", className)} {...props} />
);
export const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    icon?: string;
    color?: string;
  }
>(function ContextItem({ className, icon: _icon, color, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Item
      ref={ref}
      className={cn(menuItemClass, color === "red" && "text-red", className)}
      {...props}
    />
  );
});

export const Select = SelectPrimitive.Root;
export const SelectValue = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Value>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Value>
>(function SelectValue({ className, ...props }, ref) {
  return (
    <SelectPrimitive.Value
      ref={ref}
      className={cn("min-w-0 flex-1 truncate text-left", className)}
      {...props}
    />
  );
});
export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & { size?: "small" }
>(function SelectTrigger({ className, children, size, ...props }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        "flex w-full min-w-0 items-center justify-between gap-2 rounded-control border border-field bg-transparent px-3 text-regular outline-none transition-[background-color,border-color,box-shadow,opacity] duration-150 ease-out hover:border-primary/30 focus:border-focus-ring focus:bg-input disabled:cursor-not-allowed disabled:opacity-45",
        size === "small" ? "h-7 rounded-lg px-2" : "h-8",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="shrink-0">
        <ChevronDown className="size-4 text-tertiary" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});
export const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = "popper", ...props }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        data-slot="popover-content"
        position={position}
        className={cn(
          menuContentClass,
          "max-h-72 origin-[var(--radix-select-content-transform-origin)]",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Item ref={ref} className={cn(menuItemClass, "pl-7", className)} {...props}>
      <span className="absolute left-2">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3.5" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
});

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        "relative h-6 w-10 rounded-pill bg-control-hover shadow-control-pressed outline-none transition-[background-color,box-shadow,opacity] duration-150 ease-out hover:bg-control-active focus-visible:bg-control-active focus-visible:outline-none data-[state=checked]:bg-accent data-[state=checked]:shadow-control data-[state=checked]:hover:bg-accent-hover data-[state=checked]:focus-visible:bg-accent-hover disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow-control transition-[background-color,transform] duration-150 ease-out data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-accent-foreground" />
    </SwitchPrimitive.Root>
  );
});
export const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root> & {
    orientation?: "horizontal" | "vertical";
  }
>(function RadioGroup({ className, orientation, ...props }, ref) {
  return (
    <RadioGroupPrimitive.Root
      ref={ref}
      className={cn("flex gap-3", orientation === "vertical" && "flex-col", className)}
      {...props}
    />
  );
});
export const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(function RadioGroupItem({ className, ...props }, ref) {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        "grid size-4 place-items-center rounded-full border border-field bg-input outline-none transition-[background-color,border-color,box-shadow,opacity] duration-150 hover:border-primary/30 focus-visible:border-accent focus-visible:outline-none data-[state=checked]:border-accent disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-accent" />
    </RadioGroupPrimitive.Item>
  );
});

export const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(function Command({ className, ...props }, ref) {
  return (
    <CommandPrimitive
      ref={ref}
      className={cn("flex w-full flex-col overflow-hidden bg-transparent text-primary", className)}
      {...props}
    />
  );
});
export const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input> & {
    containerClassName?: string;
    showSeparator?: boolean;
  }
>(function CommandInput({ className, containerClassName, showSeparator = true, ...props }, ref) {
  return (
    <div
      className={cn(
        "flex h-9 items-center gap-2 px-3",
        showSeparator && "border-b border-separator",
        containerClassName,
      )}
    >
      <Search className="size-4 shrink-0 text-tertiary" />
      <CommandPrimitive.Input
        ref={ref}
        className={cn(
          "h-full min-w-0 flex-1 bg-transparent text-regular outline-none placeholder:text-secondary",
          className,
        )}
        {...props}
      />
    </div>
  );
});
export const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(function CommandList({ className, ...props }, ref) {
  return (
    <CommandPrimitive.List
      ref={ref}
      className={cn(
        "h-[min(300px,calc(100vh-9rem))] max-h-[min(300px,calc(100vh-9rem))] overflow-y-auto p-1 outline-none",
        className,
      )}
      {...props}
    />
  );
});
export const CommandEmpty = ({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>) => (
  <CommandPrimitive.Empty
    className={cn("px-3 py-6 text-center text-small text-tertiary", className)}
    {...props}
  />
);
export const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(function CommandItem({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-regular outline-none transition-colors duration-150 data-[selected=true]:bg-list-selection data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45",
        className,
      )}
      {...props}
    />
  );
});
export const CommandSeparator = ({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>) => (
  <CommandPrimitive.Separator className={cn("my-1 h-px bg-separator", className)} {...props} />
);

// Isolates a render failure to one subtree, so a single bad node no longer
// escalates to the router boundary and replaces the whole screen. A changed
// resetKey means fresh content to try, so the boundary retries instead of
// staying stuck on the fallback.
type ErrorBoundaryProps = {
  fallback: React.ReactNode;
  resetKey?: unknown;
  children: React.ReactNode;
};
type ErrorBoundaryState = { failed: boolean; resetKey: unknown };
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false, resetKey: this.props.resetKey };
  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey)
      ? null
      : { failed: false, resetKey: props.resetKey };
  }
  componentDidCatch(error: unknown) {
    reportRendererDiagnostic("react-caught", error, "subtree");
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function ErrorBoundaryView({ error, reset }: { error?: unknown; reset?: () => void }) {
  const [referenceId, setReferenceId] = React.useState<string | null>(null);
  React.useEffect(() => {
    setReferenceId(reportRendererDiagnostic("route-error", error, "router"));
  }, [error]);
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 p-8 text-center">
      <Text variant="heading1">Something went wrong</Text>
      <Text color="secondary">
        Aiden Agent could not render this screen. Try again or open Diagnostics in Settings.
      </Text>
      {referenceId ? <Text color="secondary">Reference {referenceId}</Text> : null}
      {reset ? <Button onClick={reset}>Try again</Button> : null}
    </div>
  );
}

export { AidenIcon, type AidenIconProps } from "./aiden-icon";
