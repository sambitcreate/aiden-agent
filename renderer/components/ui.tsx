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
import {
  distanceFromScrollBottom,
  followIgnoresWheel,
  followNeedsSnap,
  followReducer,
  FOLLOW_REARM_DISTANCE_PX,
  INITIAL_FOLLOW_STATE,
  isAwayScrollKey,
  isUserScrollKey,
  JUMP_BUTTON_SHOW_DELAY_MS,
  shouldOfferJumpToBottom,
  type FollowEvent,
  type FollowState,
} from "../lib/scroll-follow";
import { cn } from "../lib/ui-utils";
import { dialogEnterTarget, shouldSubmitDialogOnEnter } from "../lib/dialog-enter";
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
    | "bar"
    | "glassAccent"
    | "accent"
    | "destructive";
  size?: "small" | "medium" | "large";
  iconOnly?: boolean;
  asChild?: boolean;
  pressFeedback?: boolean;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "filled",
    size = "medium",
    iconOnly,
    asChild,
    pressFeedback = false,
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
        "dimmable inline-flex shrink-0 cursor-default items-center justify-center whitespace-nowrap border-0 text-strong outline-none transition-[background-color,color,box-shadow,opacity,transform,scale,translate] duration-(--motion-duration) ease-standard focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45 motion-reduce:transform-none [&_svg:not([class*='size-'])]:size-4",
        pressFeedback && "button-press-feedback",
        "rounded-button",
        size === "small" && "h-7 gap-1.5 px-3",
        size === "medium" && "h-8 gap-1.5 px-4 [&_svg:not([class*='size-'])]:size-4.5",
        size === "large" && "h-9 gap-2 px-5 [&_svg:not([class*='size-'])]:size-5",
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
        // Quiet top-bar action: no fill at rest, a soft fill on hover, and the
        // list selection fill while its surface is open (aria-pressed/expanded).
        variant === "bar" &&
          "bg-transparent text-toolbar-icon hover:bg-list-hover hover:text-primary active:bg-list-selection aria-pressed:bg-list-selection aria-pressed:text-primary aria-expanded:bg-list-selection aria-expanded:text-primary focus-visible:bg-list-hover",
        variant === "glassAccent" &&
          "bg-fill-accent text-fill-accent-foreground shadow-control hover:bg-fill-accent-hover hover:shadow-control-hover active:bg-fill-accent-active active:shadow-control-pressed focus-visible:bg-fill-accent-hover",
        variant === "accent" &&
          "bg-fill-accent text-fill-accent-foreground shadow-control hover:bg-fill-accent-hover hover:shadow-control-hover active:bg-fill-accent-active active:shadow-control-pressed focus-visible:bg-fill-accent-hover",
        variant === "destructive" &&
          "bg-fill-danger text-fill-danger-foreground shadow-control hover:bg-fill-danger-hover hover:shadow-control-hover active:bg-fill-danger-active active:shadow-control-pressed focus-visible:bg-fill-danger-hover",
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
        "h-8 w-full rounded-control border border-field bg-input px-3 text-regular text-primary outline-none transition-[background-color,border-color,box-shadow,opacity] duration-(--motion-duration) ease-standard placeholder:text-secondary hover:border-primary/30 focus:bg-control disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:bg-status-red-surface",
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
        "field-sizing-content w-full resize-none rounded-control border border-field bg-input px-3 py-2 text-regular text-primary outline-none transition-[background-color,border-color,box-shadow,opacity] duration-(--motion-duration) ease-standard placeholder:text-secondary hover:border-primary/30 focus:bg-control disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:bg-status-red-surface",
        density === "compact" ? "min-h-7" : "min-h-16",
        className,
      )}
      {...props}
    />
  );
});

type TextProps = React.HTMLAttributes<HTMLElement> & {
  ref?: React.Ref<HTMLElement>;
  as?: keyof React.JSX.IntrinsicElements;
  variant?: "heading1" | "strong" | "regular" | "small" | "small-strong";
  color?: "primary" | "secondary" | "tertiary" | "quaternary" | "red" | "status-red";
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
        color === "status-red" && "text-status-red",
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

export type BadgeColor = "gray" | "green" | "red" | "blue" | "warning";

export function Badge({
  color = "gray",
  icon,
  className,
  children,
  ...props
}: Omit<React.HTMLAttributes<HTMLSpanElement>, "color"> & {
  color?: BadgeColor;
  icon?: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-pill border-0 bg-control px-2 text-small-strong",
        color === "green" && "bg-status-green-surface text-status-green",
        color === "red" && "bg-status-red-surface text-status-red",
        color === "blue" && "bg-status-accent-surface text-status-accent",
        color === "warning" && "bg-status-warning-surface text-status-warning",
        className,
      )}
      {...props}
    >
      {icon ? <span className="inline-flex shrink-0 [&_svg]:size-3.5" aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}

export function Callout({
  color,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { color?: "gray" | "green" | "red" | "blue" | "warning" | (string & {}) }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 break-words rounded-card bg-well p-3",
        color === "red" && "bg-status-red-surface text-status-red [&_.text-red]:text-status-red [&_.text-support-red]:text-status-red",
        color === "green" && "bg-status-green-surface text-status-green",
        color === "blue" && "bg-status-accent-surface text-status-accent",
        color === "warning" && "bg-status-warning-surface text-status-warning",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyState({
  title,
  description,
  action,
  placement,
  role,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Next step for the user, usually a single shared `Button`. */
  action?: React.ReactNode;
  placement?: "inline";
  /** `alert` for failure states that should be announced when they appear. */
  role?: "alert" | "status";
  className?: string;
}) {
  return (
    <div
      role={role}
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
      {action ? <div className="mt-4 flex items-center justify-center gap-2">{action}</div> : null}
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
        "rounded-pill bg-control px-2 py-1 text-small-strong",
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
    <section className={cn("settings-group mb-7", className)}>
      {title ? <h2 className="settings-group-title mb-3 px-4 text-large-strong text-primary">{title}</h2> : null}
      <div className="settings-group-card overflow-visible rounded-card bg-well">{children}</div>
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
        "settings-field relative p-4 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden",
        orientation === "horizontal"
          ? "settings-field-horizontal grid min-h-12 grid-cols-[minmax(120px,0.8fr)_minmax(160px,1.2fr)] items-center gap-5 has-[[role=switch]]:grid-cols-[minmax(0,1fr)_auto] max-[540px]:grid-cols-1 max-[540px]:items-start max-[540px]:has-[[role=switch]]:grid-cols-[minmax(0,1fr)_auto] max-[540px]:has-[[role=switch]]:items-center max-[540px]:gap-2"
          : "flex flex-col gap-3",
        className,
      )}
    >
      {label || description || orientation === "horizontal" ? (
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
      ) : null}
      <div className="settings-field-control min-w-0">{children}</div>
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

/**
 * Left padding that keeps a full-width header clear of the window controls and
 * the leading sidebar-toggle/history cluster while the sidebar is collapsed.
 * The cluster starts at 90px and holds up to three 28px actions.
 */
export const SPLIT_VIEW_COLLAPSED_HEADER_INSET = 190;

/** Whether the leading sidebar is collapsed, for full-height chrome that must clear the window controls. */
export function useSplitViewCollapsed(): boolean {
  return React.useContext(SplitContext)?.collapsed === true;
}

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

  const splitContext = React.useMemo(
    () => ({ collapsed, toggle, leadingAnchor }),
    [collapsed, toggle, leadingAnchor],
  );

  return (
    <SplitContext.Provider value={splitContext}>
      <div
        data-compact-sidebar-open={compactOpen ? "true" : "false"}
        className="relative flex h-screen min-h-0 w-full overflow-hidden text-primary"
      >
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
            "absolute inset-y-0 left-0 z-10 h-full overflow-hidden bg-sidebar transition-[width,opacity] duration-300 ease-emphasized motion-reduce:transition-none",
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
          className="h-full shrink-0 transition-[width] duration-300 ease-emphasized motion-reduce:transition-none"
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
          className="relative z-0 min-w-0 flex-1 bg-background"
        >
          {children}
        </main>
        <div
          ref={setLeadingAnchor}
          inert={contentModalOpen ? true : undefined}
          aria-hidden={contentModalOpen ? true : undefined}
          className={cn(
            "absolute left-[90px] top-0 z-40 flex h-13 items-center gap-0.5",
            contentModalOpen && "pointer-events-none",
          )}
        />
      </div>
    </SplitContext.Provider>
  );
}

/**
 * The sidebar toggle, portaled beside the window controls so it stays put
 * whether the sidebar is open or collapsed. `children` follow it in the same
 * cluster (history navigation).
 */
function SidebarToggle({ children }: { children?: React.ReactNode }) {
  const context = React.useContext(SplitContext);
  const shortcut = useShortcutLabel("sidebar.toggle");
  const shortcutBinding = useShortcutBinding("sidebar.toggle");
  if (!context) return null;
  const cluster = (
    <>
      <Button
        iconOnly
        size="small"
        variant="bar"
        onClick={context.toggle}
        aria-label={context.collapsed ? "Show sidebar" : "Hide sidebar"}
        aria-keyshortcuts={ariaKeyShortcut(shortcutBinding)}
        aria-pressed={!context.collapsed}
        title={`Toggle sidebar (${shortcut})`}
        // The open sidebar is its own state cue; keep the toggle quiet.
        className="no-drag aria-pressed:bg-transparent aria-pressed:text-toolbar-icon aria-pressed:hover:bg-list-hover aria-pressed:hover:text-primary"
      >
        <PanelLeft />
      </Button>
      {children}
    </>
  );
  return context.leadingAnchor ? createPortal(cluster, context.leadingAnchor) : null;
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
      data-focus-region="sidebar"
      className="glass-surface relative flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div className="drag-region flex h-13 shrink-0 items-center justify-end px-3">{actions}</div>
      {searchable ? (
        <div className="px-3 pb-3">
          <label className="flex h-8 items-center gap-2 rounded-pill border border-transparent bg-input px-2.5 transition-[background-color,border-color,box-shadow] duration-(--motion-duration) ease-standard hover:bg-control/70 focus-within:bg-control">
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
              className="h-full min-w-0 flex-1 bg-transparent text-regular text-primary outline-none placeholder:text-tertiary"
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
export const SidebarList = ({ className, ...props }: React.ComponentProps<"div">) => (
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
        <div className="mb-1.5 px-2.5 text-small-strong font-medium text-tertiary">{title}</div>
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
        "flex min-h-9 w-full cursor-default items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-regular text-primary outline-none transition-[background-color] duration-(--motion-duration) ease-standard hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none",
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
        // Hidden when every trailing child renders nothing, so no stray gap.
        <span className="flex shrink-0 items-center gap-1 empty:hidden">{trailing}</span>
      ) : null}
    </button>
  );
}

/**
 * Whether a vertical wheel over `target` would scroll some nested scroller
 * inside `viewport` rather than the viewport itself.
 */
function nestedScrollerConsumesWheel(target: EventTarget | null, viewport: HTMLElement, deltaY: number): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== viewport) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        if (deltaY < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1) {
          return true;
        }
      }
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * Whether a reading key is consumed by a nested scroller in the direction the key specifies.
 * If a nested element can scroll in that direction, the transcript follow latch is not affected.
 */
const SPACE_ACTIVATED_CONTROLS =
  'button, summary, [role="button"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"], [role="tab"], [role="radio"]';

function nestedScrollerConsumesKey(
  target: EventTarget | null,
  viewport: HTMLElement,
  key: string,
  shiftKey: boolean,
): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== viewport) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        // Determine if the key scrolls up (negative direction) or down (positive direction).
        // Shift+Space scrolls up; Space scrolls down. Other keys follow their semantic direction.
        const scrollsUp =
          key === "ArrowUp" || key === "PageUp" || key === "Home" || (key === " " && shiftKey);
        const scrollsDown =
          key === "ArrowDown" || key === "PageDown" || key === "End" || (key === " " && !shiftKey);
        if (scrollsUp && node.scrollTop > 0) return true;
        if (scrollsDown && node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * The follow-enabled scrollport the reader last pressed in. Reading keys typed
 * with focus on the page body scroll that pane, so only it may stop following.
 */
let lastPressedFollowViewport: HTMLElement | null = null;

export function ScrollArea({
  title,
  titleAccessory,
  leading,
  actions,
  toolbar,
  footer,
  alignFooterToScrollContent = false,
  autoScrollToBottom,
  autoScrollDeps = [],
  autoScrollResetKey,
  showScrollToBottomButton,
  streaming = false,
  scrollToBottomButtonOffset = 0,
  scrollContentBottomOffset = 0,
  scrollRestorationId,
  focusRegion,
  overlay,
  className,
  children,
}: React.PropsWithChildren<{
  /**
   * Marks the scrollport as the conversation F6 moves to, so arrow keys and
   * Page Up/Down scroll it once it has focus.
   */
  focusRegion?: "chat";
  /** Floats at the top right, just below the toolbar, such as Find in chat. */
  overlay?: React.ReactNode;
  /**
   * Names this scrollport for the router's scroll restoration, so a page never
   * inherits another page's offset just because their scrollports sit at the
   * same place in the tree.
   */
  scrollRestorationId?: string;
  title?: React.ReactNode;
  /** Sits right after the title (outside the heading), such as a workspace chip. */
  titleAccessory?: React.ReactNode;
  leading?: React.ReactNode;
  actions?: React.ReactNode;
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
  /** Keep the fixed footer aligned with the scrollport when classic scrollbars reserve width. */
  alignFooterToScrollContent?: boolean;
  autoScrollToBottom?: boolean;
  autoScrollDeps?: unknown[];
  /** Changing this identity re-arms follow and pins to the latest content. */
  autoScrollResetKey?: unknown;
  showScrollToBottomButton?: boolean;
  /**
   * A reply is streaming in. The jump button then waits for a larger distance,
   * and jumping snaps instead of animating, since the next tick would cut an
   * animated scroll short.
   */
  streaming?: boolean;
  scrollToBottomButtonOffset?: number;
  scrollContentBottomOffset?: number;
  className?: string;
}>) {
  const viewport = React.useRef<HTMLDivElement>(null);
  const content = React.useRef<HTMLDivElement>(null);
  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const footerRef = React.useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = React.useState(0);
  const [footerHeight, setFooterHeight] = React.useState(0);
  const [scrollbarGutter, setScrollbarGutter] = React.useState(0);
  const footerHeightRef = React.useRef(0);
  const [following, setFollowing] = React.useState(true);
  const [offerJump, setOfferJump] = React.useState(false);
  const [atScrollEnd, setAtScrollEnd] = React.useState(true);
  const [atTop, setAtTop] = React.useState(true);
  // The follow latch lives in a ref so scroll, wheel, and resize handlers read
  // the latest decision synchronously; React state only mirrors it for paint.
  const followRef = React.useRef<FollowState>(INITIAL_FOLLOW_STATE);
  const followFrameRef = React.useRef(0);
  const offerJumpTimerRef = React.useRef(0);
  const jumpSettleTimerRef = React.useRef(0);
  const autoScrollRef = React.useRef(autoScrollToBottom);
  const streamingRef = React.useRef(streaming);
  const split = React.useContext(SplitContext);

  autoScrollRef.current = autoScrollToBottom;
  streamingRef.current = streaming;

  const syncJumpOffer = React.useCallback(() => {
    if (!shouldOfferJumpToBottom(followRef.current, streamingRef.current)) {
      // Hiding is immediate; only showing waits.
      window.clearTimeout(offerJumpTimerRef.current);
      offerJumpTimerRef.current = 0;
      setOfferJump(false);
      return;
    }
    if (offerJumpTimerRef.current) return;
    offerJumpTimerRef.current = window.setTimeout(() => {
      offerJumpTimerRef.current = 0;
      setOfferJump(shouldOfferJumpToBottom(followRef.current, streamingRef.current));
    }, JUMP_BUTTON_SHOW_DELAY_MS);
  }, []);

  const dispatchFollow = React.useCallback((event: FollowEvent) => {
    const next = followReducer(followRef.current, event);
    followRef.current = next;
    setFollowing(next.following);
    syncJumpOffer();
    return next;
  }, [syncJumpOffer]);

  React.useEffect(() => syncJumpOffer(), [streaming, syncJumpOffer]);
  React.useEffect(
    () => () => {
      window.clearTimeout(offerJumpTimerRef.current);
      window.clearTimeout(jumpSettleTimerRef.current);
    },
    [],
  );

  const measureDistance = React.useCallback((element: HTMLElement) => {
    setAtTop(element.scrollTop < 2);
    const remaining = distanceFromScrollBottom(
      element.scrollHeight,
      element.clientHeight,
      element.scrollTop,
    );
    setAtScrollEnd(remaining < 2);
    return remaining;
  }, []);

  /** Pins a following viewport to its true bottom and records where it landed. */
  const snapIfFollowing = React.useCallback((element: HTMLElement) => {
    const state = followRef.current;
    if (autoScrollRef.current && state.following && !state.jumpPending && !state.scrollbarHeld) {
      element.scrollTop = element.scrollHeight;
    }
    dispatchFollow({ type: "contentResize", distance: measureDistance(element), scrollTop: element.scrollTop });
  }, [dispatchFollow, measureDistance]);

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = viewport.current;
    if (!element) return;
    const distance = distanceFromScrollBottom(element.scrollHeight, element.clientHeight, element.scrollTop);
    // Streaming ticks cut animated scrolls short, and a smooth scroll that
    // has nowhere to go never fires scrollend, so both snap instead, as does
    // Reduce Motion (CSS scroll-behavior does not reach a scripted scroll).
    const smooth =
      behavior === "smooth" &&
      !streamingRef.current &&
      distance > 1 &&
      document.documentElement.dataset.reduceMotion !== "true";
    dispatchFollow({ type: "jump", smooth });
    window.clearTimeout(jumpSettleTimerRef.current);
    if (smooth) {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
      // scrollend normally lands the jump; this only covers an animation the
      // engine dropped without one.
      jumpSettleTimerRef.current = window.setTimeout(() => {
        if (!followRef.current.jumpPending || !viewport.current) return;
        dispatchFollow({
          type: "settle",
          distance: measureDistance(viewport.current),
          scrollTop: viewport.current.scrollTop,
          ended: true,
        });
        snapIfFollowing(viewport.current);
      }, 1000);
    } else {
      snapIfFollowing(element);
    }
    // Re-check once layout settles: late images, fonts, and the jump button's
    // own removal can all move the bottom after this frame.
    requestAnimationFrame(() => {
      const current = viewport.current;
      if (current && followNeedsSnap(followRef.current)) snapIfFollowing(current);
    });
  }, [dispatchFollow, measureDistance, snapIfFollowing]);

  React.useEffect(() => {
    const element = viewport.current;
    if (!element || !autoScrollToBottom) return;
    const overflows = () => element.scrollHeight > element.clientHeight + 1;
    const onScrollEnd = () => {
      const wasPending = followRef.current.jumpPending;
      const next = dispatchFollow({
        type: "settle",
        distance: measureDistance(element),
        scrollTop: element.scrollTop,
        ended: true,
      });
      if (wasPending && followNeedsSnap(next)) snapIfFollowing(element);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY >= 0) return;
      // A sideways trackpad pan over a wide code block or table is not reading back.
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (nestedScrollerConsumesWheel(event.target, element, event.deltaY)) return;
      const at = event.timeStamp;
      if (followIgnoresWheel(followRef.current, at)) {
        // Momentum from a gesture that began before the jump: it must neither
        // break follow nor drag the freshly pinned view away.
        event.preventDefault();
      }
      dispatchFollow({ type: "userIntent", intent: "wheelUp", at, canScrollUp: overflows() });
    };
    const onTouchStart = () => {
      // Touching the viewport ends a smooth jump without breaking follow.
      dispatchFollow({ type: "userIntent", intent: "drag", at: performance.now(), canScrollUp: false });
    };
    const onTouchMove = () => {
      // Touch direction is not observable here, so a drag breaks follow only
      // once it has carried the viewport out of the re-arm band.
      const distance = distanceFromScrollBottom(element.scrollHeight, element.clientHeight, element.scrollTop);
      if (distance > FOLLOW_REARM_DISTANCE_PX) {
        dispatchFollow({ type: "userIntent", intent: "drag", at: performance.now(), canScrollUp: true });
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      lastPressedFollowViewport = element;
      // Only the viewport's own box (its scrollbar) starts a scrollbar hold.
      // The press itself keeps follow: only where the thumb settles counts.
      if (event.target !== element) return;
      dispatchFollow({ type: "scrollbarHold" });
    };
    const onPointerUp = () => {
      if (!followRef.current.scrollbarHeld) return;
      const next = dispatchFollow({ type: "scrollbarRelease", distance: measureDistance(element) });
      // If still following after release (unmoved hold, or released near the end),
      // snap to the new bottom to settle any growth that was deferred while held.
      if (followNeedsSnap(next)) snapIfFollowing(element);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      // Clicking transcript text can leave focus on body; its scrolling keys
      // still move the pane that was pressed last, and only that one.
      if (!element.contains(target)) {
        if (target !== document.body) return;
        if (lastPressedFollowViewport && lastPressedFollowViewport !== element) return;
      }
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName)) return;
      if (!isUserScrollKey(event.key)) return;
      // Space on a focused control presses it rather than scrolling.
      if (event.key === " " && target.closest(SPACE_ACTIVATED_CONTROLS)) return;
      // A nested scrollable element in the direction this key moves leaves follow alone.
      if (nestedScrollerConsumesKey(event.target, element, event.key, event.shiftKey)) return;
      dispatchFollow({
        type: "userIntent",
        intent: "key",
        at: performance.now(),
        canScrollUp: isAwayScrollKey(event.key, event.shiftKey) && overflows(),
      });
    };
    element.addEventListener("scrollend", onScrollEnd);
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: true });
    element.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      element.removeEventListener("scrollend", onScrollEnd);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("keydown", onKeyDown);
      if (lastPressedFollowViewport === element) lastPressedFollowViewport = null;
    };
  }, [autoScrollToBottom, dispatchFollow, measureDistance, snapIfFollowing]);

  const followBottomNow = React.useCallback(() => {
    const element = viewport.current;
    if (element) snapIfFollowing(element);
  }, [snapIfFollowing]);

  const scheduleFollowBottom = React.useCallback(() => {
    followBottomNow();
    if (followFrameRef.current) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = 0;
      followBottomNow();
    });
  }, [followBottomNow]);

  const hasToolbar = Boolean(toolbar ?? (title || leading || actions));
  const hasFooter = Boolean(footer);
  React.useLayoutEffect(() => {
    const measure = () => {
      const nextToolbarHeight = toolbarRef.current?.getBoundingClientRect().height ?? 0;
      setToolbarHeight((current) => current === nextToolbarHeight ? current : nextToolbarHeight);
      const nextFooterHeight = footerRef.current?.getBoundingClientRect().height ?? 0;
      if (alignFooterToScrollContent) {
        const scrollViewport = viewport.current;
        const nextScrollbarGutter = scrollViewport
          ? Math.max(0, scrollViewport.offsetWidth - scrollViewport.clientWidth)
          : 0;
        setScrollbarGutter((current) => current === nextScrollbarGutter ? current : nextScrollbarGutter);
      }
      if (nextFooterHeight !== footerHeightRef.current) {
        footerHeightRef.current = nextFooterHeight;
        setFooterHeight(nextFooterHeight);
        scheduleFollowBottom();
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (alignFooterToScrollContent && viewport.current) observer.observe(viewport.current);
    if (toolbarRef.current) observer.observe(toolbarRef.current);
    if (footerRef.current) observer.observe(footerRef.current);
    return () => observer.disconnect();
    // Content changes inside the toolbar/footer surface through the observer;
    // only their presence decides which elements are observed.
  }, [alignFooterToScrollContent, hasToolbar, hasFooter, scheduleFollowBottom]);

  React.useLayoutEffect(() => {
    scheduleFollowBottom();
  }, [autoScrollToBottom, ...autoScrollDeps]);

  React.useLayoutEffect(() => {
    if (autoScrollResetKey === undefined) return;
    dispatchFollow({ type: "reset" });
    if (autoScrollToBottom) scheduleFollowBottom();
  }, [autoScrollResetKey, autoScrollToBottom, dispatchFollow, scheduleFollowBottom]);

  React.useLayoutEffect(() => {
    const element = viewport.current;
    const contentElement = content.current;
    if (!element) return;
    const update = scheduleFollowBottom;
    // Settle synchronously first so the viewport never paints at scrollTop 0 and
    // then jumps; the frame after still catches late layout (fonts, images).
    snapIfFollowing(element);
    const frame = requestAnimationFrame(update);
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(element);
    if (contentElement) resizeObserver.observe(contentElement);
    return () => {
      cancelAnimationFrame(frame);
      if (followFrameRef.current) cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = 0;
      resizeObserver.disconnect();
    };
  }, [autoScrollToBottom, scheduleFollowBottom, scrollContentBottomOffset, snapIfFollowing]);

  const resolvedToolbar =
    toolbar ??
    (title || leading || actions ? (
      <header
        data-toolbar
        className="scroll-area-header drag-region relative flex min-h-13 items-center gap-3 px-4 transition-[padding] duration-300 ease-emphasized motion-reduce:transition-none"
        style={{ paddingLeft: split?.collapsed ? SPLIT_VIEW_COLLAPSED_HEADER_INSET : undefined }}
      >
        <div className="no-drag flex shrink-0 items-center">{leading}</div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* With an accessory beside it, the title keeps a readable minimum. */}
          <h1 className={cn("min-w-0 truncate text-strong text-primary", titleAccessory && "min-w-24")}>
            {title}
          </h1>
          {titleAccessory}
        </div>
        <div className="no-drag flex items-center gap-2">{actions}</div>
      </header>
    ) : null);

  return (
    <div
      data-scroll-area
      className={cn("relative isolate h-full min-h-0 overflow-hidden bg-background", className)}
      // Sticky descendants (transcript section headers) rest just below the
      // overlaid toolbar instead of sliding underneath it.
      style={{ "--scroll-area-sticky-top": `${toolbarHeight}px` } as React.CSSProperties}
    >
      {resolvedToolbar ? (
        <div ref={toolbarRef} className="absolute inset-x-0 top-0 z-30">
          {resolvedToolbar}
        </div>
      ) : null}
      <div
        ref={viewport}
        data-scroll-restoration-id={scrollRestorationId}
        data-scroll-top={atTop}
        data-scroll-bottom={atScrollEnd}
        data-follow={autoScrollToBottom ? following : undefined}
        {...(focusRegion
          ? {
              "data-focus-region": focusRegion,
              "data-focus-region-entry": "",
              role: "region",
              "aria-label": "Conversation",
              tabIndex: -1,
            }
          : {})}
        className={cn(
          "scroll-edge-mask relative z-0 h-full w-full overflow-y-auto overscroll-contain",
          focusRegion && "conversation-scrollport",
        )}
        style={{
          paddingTop: toolbarHeight,
          paddingBottom: footerHeight + Math.max(0, scrollContentBottomOffset),
          // While following, the latch owns the bottom edge; browser scroll
          // anchoring would fight it by holding a mid-transcript node still.
          // A reader who has scrolled away keeps anchoring, so content changing
          // above their place does not shift what they are reading.
          overflowAnchor: autoScrollToBottom && following ? "none" : undefined,
        }}
        onScroll={(event) => {
          dispatchFollow({
            type: "settle",
            distance: measureDistance(event.currentTarget),
            scrollTop: event.currentTarget.scrollTop,
          });
        }}
      >
        <div ref={content} data-scroll-content className="min-h-full">
          {children}
        </div>
      </div>
      {focusRegion ? (
        // The conversation's keyboard focus ring, drawn below the overlaid toolbar.
        <div aria-hidden className="conversation-focus-ring pointer-events-none absolute inset-x-0 bottom-0 z-20" style={{ top: toolbarHeight }} />
      ) : null}
      {overlay ? (
        <div
          className="pointer-events-none absolute inset-x-0 z-30 flex justify-end px-4"
          style={{ top: toolbarHeight + 8 }}
        >
          <div className="pointer-events-auto">{overlay}</div>
        </div>
      ) : null}
      {showScrollToBottomButton && offerJump ? (
        // The button floats over the scrollport like the footer, but is centred
        // on the same chat column as the composer, so it follows the column
        // when Quick View insets it (and through that transition) and when a
        // classic scrollbar takes a gutter.
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20"
          style={alignFooterToScrollContent ? { insetInlineEnd: scrollbarGutter } : undefined}
        >
          <div className="aiden-dock-inset chat-content-column relative">
            <Button
              iconOnly
              size="medium"
              variant="filled"
              onClick={() => scrollToBottom()}
              aria-label="Scroll to bottom"
              className="pointer-events-auto absolute left-1/2 -translate-x-1/2 bg-popover/95 shadow-popover hover:bg-popover"
              style={{ bottom: footerHeight + 12 + Math.max(0, scrollToBottomButtonOffset) }}
            >
              <ArrowDownToLine />
            </Button>
          </div>
        </div>
      ) : null}
      {footer ? (
        // Nothing scrolls the footer, so it never grows under the toolbar; a child
        // that opts in with min-h-0 (a tall approval) shrinks to the room left.
        // Anything still too tall overflows through the top, keeping the
        // composer's input and actions at the bottom in view.
        <div
          ref={footerRef}
          className="absolute inset-x-0 bottom-0 z-10 flex flex-col justify-end"
          style={{
            maxHeight: `calc(100% - ${toolbarHeight}px)`,
            ...(alignFooterToScrollContent ? { insetInlineEnd: scrollbarGutter } : undefined),
          }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A ScrollArea footer's rows as one column that can give up room: a row that
 * opts in with min-h-0 (a pending approval) shrinks first, and anything still
 * too tall leaves through the top so the last row (the composer) stays in view.
 */
export function ScrollAreaFooterStack({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex min-h-0 flex-col justify-end", className)} {...props} />;
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
  cancelLabel?: string;
  onCancel?: () => void | Promise<void>;
  /**
   * The cancel button runs `onCancel` without closing the dialog, for a step
   * back inside a multi-step dialog. Escape and outside clicks still close it.
   */
  cancelKeepsOpen?: boolean;
  allowCancelWhileBusy?: boolean;
  actionClassName?: string;
  busy?: boolean;
  onConfirm?: () => void | Promise<void>;
  returnFocus?: () => HTMLElement | null;
  /** "wide" fits a two-pane dialog with its own tab list; "full" fills the window (an image's full view). */
  size?: "large" | "wide" | "full";
  layer?: DialogLayer;
  /**
   * Run the confirm action on Enter in a single-line field, or Mod+Enter anywhere in the
   * dialog, while confirm is visible, enabled, and not busy.
   */
  submitOnEnter?: boolean;
  /** Runs before Escape dismisses the dialog; call `preventDefault()` to keep it open. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
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
  cancelLabel,
  onCancel,
  cancelKeepsOpen = false,
  allowCancelWhileBusy,
  actionClassName,
  busy,
  onConfirm,
  returnFocus,
  size,
  layer = "default",
  submitOnEnter = false,
  onEscapeKeyDown,
  children,
}: DialogProps) {
  const dismissBlocked = Boolean(
    dismissDisabled || cancelDisabled || (busy && !allowCancelWhileBusy),
  );

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
          onEscapeKeyDown={(event) => {
            onEscapeKeyDown?.(event);
            if (dismissBlocked) event.preventDefault();
          }}
          onPointerDownOutside={(event) => dismissBlocked && event.preventDefault()}
          onKeyDown={
            submitOnEnter
              ? (event) => {
                  if (confirmHidden || confirmDisabled || busy || !onConfirm) return;
                  const target = event.target;
                  // React events bubble through portals; ignore keys from nested popovers or dialogs.
                  if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
                  const key = {
                    key: event.key,
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    altKey: event.altKey,
                    isComposing: event.nativeEvent.isComposing,
                    defaultPrevented: event.defaultPrevented,
                  };
                  if (!shouldSubmitDialogOnEnter(key, dialogEnterTarget(target))) return;
                  event.preventDefault();
                  void onConfirm();
                }
              : undefined
          }
          className={cn(
            "fixed left-1/2 top-1/2 flex max-h-[85vh] w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-dialog bg-popover px-6 py-5 outline-none",
            layer === "onboarding" ? "z-[70] shadow-onboarding" : "z-50 shadow-modal",
            size === "large" && "w-[min(92vw,680px)]",
            size === "wide" && "w-[min(92vw,860px)]",
            size === "full" && "h-[94vh] max-h-[94vh] w-[96vw]",
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
          <div className={cn("mt-4 min-h-0 overflow-y-auto px-0.5", size === "full" && "flex-1")}>{children}</div>
          <div className="mt-5 flex shrink-0 justify-end gap-2">
            {cancelKeepsOpen ? (
              <Button
                ref={cancelRef}
                variant="filled"
                className={actionClassName}
                disabled={dismissBlocked}
                onClick={() => void onCancel?.()}
              >
                {cancelLabel ?? (confirmHidden ? "Close" : "Cancel")}
              </Button>
            ) : (
              <DialogPrimitive.Close asChild>
                <Button
                  ref={cancelRef}
                  variant="filled"
                  className={actionClassName}
                  disabled={dismissBlocked}
                  onClick={() => void onCancel?.()}
                >
                  {cancelLabel ?? (confirmHidden ? "Close" : "Cancel")}
                </Button>
              </DialogPrimitive.Close>
            )}
            {confirmHidden ? null : (
              <Button
                variant="accent"
                className={actionClassName}
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
  // Remember what had focus when the dialog opened so closing can return there.
  const openerRef = React.useRef<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);
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
            const opener = openerRef.current?.isConnected ? openerRef.current : null;
            openerRef.current = null;
            const target =
              returnFocus?.() ??
              opener ??
              document.querySelector<HTMLElement>("[data-app-focus-root]");
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
// Destructive rows keep their red when highlighted: a deep red fill with
// white text in dark themes rather than the neutral accent highlight.
const destructiveHighlightClass =
  "data-[highlighted]:bg-fill-danger data-[highlighted]:text-fill-danger-foreground";
const menuItemClass =
  "relative flex min-h-7 cursor-default select-none items-center gap-2 rounded-lg px-2 py-1 text-regular outline-none transition-colors duration-(--motion-duration) ease-standard data-[highlighted]:bg-fill-accent data-[highlighted]:text-fill-accent-foreground data-[highlighted]:**:text-current data-[disabled]:pointer-events-none data-[disabled]:opacity-45";

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
      className={cn(menuItemClass, color === "red" && "text-red",
        color === "status-red" && "text-status-red",
        (color === "red" || color === "status-red") && destructiveHighlightClass, className)}
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
          <span className="max-w-72 text-small text-tertiary">
            {sublabel}
          </span>
        ) : null}
      </span>
    </DropdownMenuPrimitive.CheckboxItem>
  );
});
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;
/** Single-choice menu row; the check mark and `aria-checked` carry selection. */
export const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(function RadioItem({ className, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
      className={cn(menuItemClass, "group pl-7", className)}
      {...props}
    >
      <span className="absolute left-2">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-3.5" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
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
      className={cn(menuItemClass, color === "red" && "text-red",
        color === "status-red" && "text-status-red",
        (color === "red" || color === "status-red") && destructiveHighlightClass, className)}
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
        "flex w-full min-w-0 items-center justify-between gap-2 rounded-control border border-field bg-input px-3 text-regular outline-none transition-[background-color,border-color,box-shadow,opacity] duration-(--motion-duration) ease-standard hover:border-primary/30 focus:bg-control disabled:cursor-not-allowed disabled:opacity-45",
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
        "relative inline-flex h-6 w-10 shrink-0 items-center overflow-visible rounded-pill bg-control-hover shadow-control-pressed outline-none transition-[background-color,box-shadow,opacity] duration-(--motion-duration) ease-standard hover:bg-control-active focus-visible:bg-control-active focus-visible:outline-none data-[state=checked]:bg-fill-accent data-[state=checked]:shadow-control data-[state=checked]:hover:bg-fill-accent-hover data-[state=checked]:focus-visible:bg-fill-accent-hover disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-5 shrink-0 translate-x-0.5 rounded-full bg-white shadow-control transition-[background-color,transform] duration-(--motion-duration) ease-standard data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-fill-accent-foreground" />
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
        "grid size-4 place-items-center rounded-full border-0 bg-tertiary outline-none transition-[background-color,box-shadow,opacity] duration-(--motion-duration) ease-standard hover:bg-secondary focus-visible:outline-none data-[state=checked]:bg-fill-accent disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="size-1.5 rounded-full bg-fill-accent-foreground" />
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
/** A labelled run of command items; the heading names the group for assistive tech. */
export const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(function CommandGroup({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Group
      ref={ref}
      className={cn(
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-small-strong [&_[cmdk-group-heading]]:text-tertiary",
        className,
      )}
      {...props}
    />
  );
});
export const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(function CommandItem({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-regular outline-none transition-colors duration-(--motion-duration) ease-standard data-[selected=true]:bg-list-selection data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45",
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
