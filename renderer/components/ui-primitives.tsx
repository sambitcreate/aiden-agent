import * as React from "react";
import { Check, ChevronRight, TrendingDown, TrendingUp } from "lucide-react";
import {
  Checkbox as CheckboxPrimitive,
  Collapsible as CollapsiblePrimitive,
  Progress as ProgressPrimitive,
  RadioGroup as RadioGroupPrimitive,
  Slider as SliderPrimitive,
  Tabs as TabsPrimitive,
  Tooltip as TooltipPrimitive,
} from "radix-ui";
import { cn } from "../lib/ui-utils";
import { Button } from "./ui";

/**
 * Shared selection, progress, and data primitives. The app and Aiden UI
 * visuals draw with the same parts. All of them use semantic tokens only and
 * keep the neutral keyboard focus ring on non-text controls.
 */

export interface ChoiceOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

/** A single choice shown as joined segments (a filter, a metric switch). */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  className,
  disabled,
  ...aria
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly ChoiceOption<T>[];
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      orientation="horizontal"
      loop
      disabled={disabled}
      className={cn("inline-flex max-w-full min-w-0 gap-0.5 rounded-control bg-control p-0.5", className)}
      {...aria}
    >
      {options.map((option) => (
        <RadioGroupPrimitive.Item
          key={option.value}
          value={option.value}
          className="h-7 min-w-0 truncate rounded-menu px-3 text-small text-secondary outline-none transition-[background-color,color,box-shadow] duration-(--motion-duration) ease-standard hover:text-primary disabled:pointer-events-none disabled:opacity-45 data-[state=checked]:bg-popover data-[state=checked]:text-primary data-[state=checked]:shadow-control"
        >
          {option.label}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}

/** A tab strip. Callers render the selected panel themselves. */
export function Tabs<T extends string>({
  value,
  onValueChange,
  items,
  className,
  ...aria
}: {
  value: T;
  onValueChange: (value: T) => void;
  items: readonly ChoiceOption<T>[];
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={(next) => onValueChange(next as T)}>
      <TabsPrimitive.List className={cn("flex min-w-0 flex-wrap gap-1", className)} loop {...aria}>
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            className="h-7 rounded-menu px-3 text-small text-secondary outline-none transition-[background-color,color] duration-(--motion-duration) ease-standard hover:bg-control hover:text-primary data-[state=active]:bg-control data-[state=active]:text-primary"
          >
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = React.useId();
  return (
    <div className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <CheckboxPrimitive.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="grid size-4 shrink-0 place-items-center rounded-md bg-control-hover shadow-control-pressed outline-none transition-[background-color,box-shadow] duration-(--motion-duration) ease-standard hover:bg-control-active disabled:pointer-events-none disabled:opacity-45 data-[state=checked]:bg-accent data-[state=checked]:shadow-control"
      >
        <CheckboxPrimitive.Indicator>
          <Check aria-hidden="true" className="size-3 text-accent-foreground" strokeWidth={3} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <label htmlFor={id} className="min-w-0 text-small text-primary">
        {label}
      </label>
    </div>
  );
}

export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  valueLabel,
  disabled,
  className,
}: {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  valueLabel?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2 text-small">
        <span className="text-secondary">{label}</span>
        <span className="tabular-nums text-primary">{valueLabel ?? value}</span>
      </div>
      <SliderPrimitive.Root
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={([next]) => {
          if (typeof next === "number") onValueChange(next);
        }}
        className="relative flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-45"
      >
        <SliderPrimitive.Track className="relative h-1 grow overflow-hidden rounded-pill bg-control">
          <SliderPrimitive.Range className="absolute h-full rounded-pill bg-accent" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label={label}
          className="block size-4 rounded-full bg-popover shadow-control outline-none transition-[box-shadow] duration-(--motion-duration) ease-standard hover:shadow-control-hover"
        />
      </SliderPrimitive.Root>
    </div>
  );
}

/** A thin determinate (or indeterminate) progress track. */
export function Progress({
  value,
  max = 100,
  label,
  indeterminate,
  className,
}: {
  value?: number;
  max?: number;
  label: string;
  indeterminate?: boolean;
  className?: string;
}) {
  const clamped = indeterminate || value === undefined ? null : Math.min(Math.max(value, 0), max);
  return (
    <ProgressPrimitive.Root
      value={clamped === null ? null : Math.floor(clamped)}
      max={max}
      aria-label={label}
      className={cn("relative h-1 w-full overflow-hidden rounded-pill bg-control", className)}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          "h-full rounded-pill bg-accent transition-[width] duration-(--motion-duration) ease-standard",
          clamped === null && "w-1/3 opacity-60",
        )}
        style={clamped === null ? undefined : { width: `${(clamped / max) * 100}%` }}
      />
    </ProgressPrimitive.Root>
  );
}

/** A hover and focus hint. Needs the app's TooltipProvider (mounted at the root). */
export function Tooltip({ content, children }: { content: React.ReactNode; children: React.ReactElement }) {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          className="z-50 max-w-64 rounded-menu bg-popover px-2.5 py-1.5 text-small text-primary shadow-popover"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function Disclosure({
  title,
  defaultOpen = false,
  children,
  className,
}: {
  title: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <CollapsiblePrimitive.Root open={open} onOpenChange={setOpen} className={cn("flex min-w-0 flex-col gap-1", className)}>
      <CollapsiblePrimitive.Trigger asChild>
        <Button variant="transparent" size="small" className="self-start">
          <ChevronRight
            aria-hidden="true"
            className={cn("size-3.5 transition-transform duration-(--motion-duration) ease-standard", open && "rotate-90")}
          />
          {title}
        </Button>
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="min-w-0 pl-1">{children}</CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex rounded-md bg-control px-1.5 py-0.5 font-sans text-mini text-secondary", className)}>
      {children}
    </kbd>
  );
}

const PERCENT = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1, signDisplay: "always" });

export function Stat({
  label,
  value,
  caption,
  trend,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  caption?: React.ReactNode;
  /** Relative change, e.g. 0.12 for +12%. */
  trend?: number;
  className?: string;
}) {
  const up = trend !== undefined && trend >= 0;
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <span className="truncate text-small text-secondary">{label}</span>
      <span className="truncate text-heading1 font-semibold tabular-nums text-primary">{value}</span>
      {trend !== undefined || caption ? (
        <span className="flex min-w-0 items-center gap-1 text-small text-secondary">
          {trend !== undefined ? (
            <span className={cn("inline-flex items-center gap-0.5 tabular-nums", up ? "text-status-green" : "text-status-red")}>
              {up ? <TrendingUp aria-hidden="true" className="size-3.5" /> : <TrendingDown aria-hidden="true" className="size-3.5" />}
              {PERCENT.format(trend)}
            </span>
          ) : null}
          {caption ? <span className="truncate">{caption}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

export interface DataTableColumn {
  key: string;
  label: React.ReactNode;
  align?: "start" | "end";
}

export function DataTable({
  columns,
  rows,
  caption,
  className,
}: {
  columns: readonly DataTableColumn[];
  rows: readonly Record<string, React.ReactNode>[];
  caption?: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 overflow-x-auto", className)}>
      <table className="w-full border-collapse text-small">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  "border-b border-separator px-2 py-1.5 font-medium text-secondary",
                  column.align === "end" ? "text-right" : "text-left",
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="[&:not(:last-child)>td]:border-b [&>td]:border-separator">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn("px-2 py-1.5 text-primary", column.align === "end" ? "text-right tabular-nums" : "text-left")}
                >
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
