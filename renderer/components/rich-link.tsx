import * as React from "react";
import {
  Box,
  Building2,
  CalendarDays,
  ExternalLink,
  FileText,
  FolderOpen,
  Github,
  Gitlab,
  Link2,
  Mail,
  MessageSquare,
  NotebookTabs,
  Presentation,
  Slack,
  Table2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "./ui";
import {
  describeRichLink,
  type RichLinkDescriptor,
  type RichLinkProvider,
  type RichLinkResourceKind,
} from "../lib/rich-link";
import { cn } from "../lib/ui-utils";

const PROVIDER_ICONS: Record<RichLinkProvider, LucideIcon> = {
  github: Github,
  gitlab: Gitlab,
  "google-drive": FileText,
  sharepoint: Building2,
  box: Box,
  notion: NotebookTabs,
  slack: Slack,
  teams: MessageSquare,
  outlook: Mail,
};

const RESOURCE_ICONS: Partial<Record<RichLinkResourceKind, LucideIcon>> = {
  file: FileText,
  folder: FolderOpen,
  document: FileText,
  spreadsheet: Table2,
  presentation: Presentation,
  message: MessageSquare,
  meeting: CalendarDays,
  email: Mail,
  calendar: CalendarDays,
  workflow: Workflow,
};

export interface RichLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  descriptor?: RichLinkDescriptor;
}

interface RichLinkBudgetState {
  decisions: Map<string, boolean>;
  used: number;
  limit: number;
  // Denied links waiting for a slot that a replaced link gives back.
  waiting: Set<() => void>;
}

const RichLinkBudgetContext = React.createContext<RichLinkBudgetState | null>(null);

export function RichLinkBudget({
  children,
  limit,
}: {
  children: React.ReactNode;
  limit: number;
}) {
  const budget = React.useMemo<RichLinkBudgetState>(
    () => ({ decisions: new Map(), used: 0, limit, waiting: new Set() }),
    [limit],
  );
  return (
    <RichLinkBudgetContext.Provider value={budget}>
      {children}
    </RichLinkBudgetContext.Provider>
  );
}

export function RichLink({
  href,
  descriptor: suppliedDescriptor,
  ...props
}: RichLinkProps) {
  const descriptor = suppliedDescriptor ?? describeRichLink(href);
  if (!descriptor) return <a href={href} {...props} />;
  return <BudgetedRichLink href={href} descriptor={descriptor} {...props} />;
}

function BudgetedRichLink({
  href,
  descriptor,
  ...props
}: Omit<RichLinkProps, "descriptor"> & { descriptor: RichLinkDescriptor }) {
  const budgetId = React.useId();
  const budget = React.useContext(RichLinkBudgetContext);
  let withinBudget = true;
  if (budget) {
    const existingDecision = budget.decisions.get(budgetId);
    if (existingDecision === undefined) {
      withinBudget = budget.used < budget.limit;
      budget.decisions.set(budgetId, withinBudget);
      if (withinBudget) budget.used += 1;
    } else {
      withinBudget = existingDecision;
    }
  }

  // A reparsed document replaces anchors (a tight list turning loose), and
  // the replacements decide before the old ones unmount. Each link returns its
  // slot when it goes, and a denied link takes a freed slot, so the budget
  // counts only the links on screen.
  const [, retry] = React.useReducer((attempt: number) => attempt + 1, 0);
  React.useEffect(() => {
    if (!budget) return;
    // StrictMode remounts after the cleanup below gave the slot back.
    if (!budget.decisions.has(budgetId)) budget.decisions.set(budgetId, false);
    const takeFreedSlot = () => {
      if (budget.decisions.get(budgetId) !== false || budget.used >= budget.limit) return;
      budget.decisions.delete(budgetId);
      retry();
    };
    budget.waiting.add(takeFreedSlot);
    takeFreedSlot();
    return () => {
      budget.waiting.delete(takeFreedSlot);
      const approved = budget.decisions.get(budgetId);
      budget.decisions.delete(budgetId);
      if (!approved) return;
      budget.used -= 1;
      for (const waiter of budget.waiting) waiter();
    };
  }, [budget, budgetId]);

  if (!withinBudget) return <a href={href} {...props} />;
  return <RichLinkPreview href={href} descriptor={descriptor} {...props} />;
}

function RichLinkPreview({
  href,
  descriptor,
  children,
  className,
  onBlur,
  onFocus,
  onKeyDown,
  onPointerEnter,
  ...anchorProps
}: Omit<RichLinkProps, "descriptor"> & { descriptor: RichLinkDescriptor }) {
  const [open, setOpen] = React.useState(false);
  const dismissedWhileFocusedRef = React.useRef(false);
  const descriptionId = React.useId();

  const ProviderIcon = PROVIDER_ICONS[descriptor.provider];
  const ResourceIcon = RESOURCE_ICONS[descriptor.resourceKind] ?? Link2;
  const accessibleContext = `${descriptor.providerLabel} ${descriptor.resourceLabel}`;

  return (
    <HoverCard
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen && dismissedWhileFocusedRef.current) return;
        setOpen(nextOpen);
      }}
      openDelay={160}
      closeDelay={120}
    >
      <HoverCardTrigger asChild>
        <a
          href={href}
          {...anchorProps}
          className={cn(
            "rounded-[2px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            className,
          )}
          aria-describedby={open ? descriptionId : undefined}
          data-rich-link-provider={descriptor.provider}
          data-rich-link-resource={descriptor.resourceKind}
          onFocus={(event) => {
            onFocus?.(event);
            if (!event.defaultPrevented) {
              dismissedWhileFocusedRef.current = false;
              setOpen(true);
            }
          }}
          onBlur={(event) => {
            onBlur?.(event);
            if (!event.defaultPrevented) {
              dismissedWhileFocusedRef.current = false;
              setOpen(false);
            }
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (!event.defaultPrevented && event.key === "Escape") {
              dismissedWhileFocusedRef.current = true;
              setOpen(false);
            }
          }}
          onPointerEnter={(event) => {
            onPointerEnter?.(event);
            if (!event.defaultPrevented) dismissedWhileFocusedRef.current = false;
          }}
        >
          <ProviderIcon
            aria-hidden="true"
            className="mr-1 inline size-[0.95em] shrink-0 -translate-y-px motion-reduce:transform-none"
          />
          {children}
          <span className="sr-only"> ({accessibleContext})</span>
        </a>
      </HoverCardTrigger>
      <HoverCardContent
        id={descriptionId}
        role="tooltip"
        side="top"
        align="start"
        collisionPadding={12}
        className="w-[min(22rem,calc(100vw-2rem))] select-text"
      >
        <div className="flex min-w-0 gap-2.5">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-control bg-well text-secondary">
            <ResourceIcon aria-hidden="true" className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5 text-small text-secondary">
              <ProviderIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{descriptor.providerLabel}</span>
              <span aria-hidden="true" className="text-quaternary">·</span>
              <span className="truncate">{descriptor.resourceLabel}</span>
            </div>
            <div className="mt-1 break-words text-regular font-medium text-primary">
              {descriptor.primaryLabel}
            </div>
            {descriptor.secondaryLabel ? (
              <div className="mt-0.5 break-words text-small text-secondary">
                {descriptor.secondaryLabel}
              </div>
            ) : null}
            <div className="mt-2 flex min-w-0 items-center gap-1 text-mini text-tertiary">
              <span className="truncate" dir="ltr">{descriptor.safeDisplayUrl}</span>
              <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
              <span className="shrink-0">Opens link</span>
            </div>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
