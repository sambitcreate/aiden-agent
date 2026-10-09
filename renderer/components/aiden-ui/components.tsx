import * as React from "react";
import {
  Activity, Archive, ArrowDown, ArrowRight, ArrowUp, Battery, BookOpen, Bug, Calendar, Camera, ChartBar, ChartLine,
  ChartPie, Check, Circle, CircleAlert, CircleCheck, CircleX, Clock, Cloud, Code, Coffee, Cpu, CreditCard, Database,
  DollarSign, Download, FileText, Flag, Folder, GitBranch, Globe, GraduationCap, Heart, House, Image, Info, Leaf,
  Lightbulb, Link, Lock, Mail, MapPin, MessageSquare, Minus, Moon, Music, Package, Phone, Plus, Rocket, Search, Server,
  Settings, Shield, ShoppingCart, Sparkles, Star, Sun, Target, Terminal, ThumbsDown, ThumbsUp, Timer, TrendingDown,
  TrendingUp, TriangleAlert, Truck, Upload, User, Users, Video, Wifi, Wrench, X, Zap,
  type LucideIcon,
} from "lucide-react";
import { truthy } from "../../shared/aiden-ui/evaluate";
import type { AidenUiIconName } from "../../shared/aiden-ui/catalog";
import type { AidenUiNodeV1 } from "../../shared/aiden-ui/types";
import { cn } from "../../lib/ui-utils";
import { CodeBlock } from "../code-block";
import { Markdown, MarkdownInline } from "../markdown";
import {
  Badge,
  type BadgeColor,
  Button,
  Callout,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Switch,
} from "../ui";
import { Checkbox, DataTable, Disclosure, Kbd, Progress, Segmented, Slider, Stat, Tabs, Tooltip } from "../ui-primitives";
import { AidenUiBarList, AidenUiChart, AidenUiHeatmap, AidenUiSparkline, formatCell, type ChartProps } from "./chart";
import {
  asNumber,
  asRecord,
  asString,
  isAction,
  normalizeOptions,
  optionKey,
  readProp,
  type AidenUiRenderContext,
} from "./render-context";

/**
 * Catalog name → React component. Every component reads its props through
 * the evaluator in the current scope and draws with Aiden's shared parts.
 */

export interface CatalogComponentProps {
  node: AidenUiNodeV1;
  ctx: AidenUiRenderContext;
}

type CatalogComponent = (props: CatalogComponentProps) => React.ReactNode;

const ICONS: Record<AidenUiIconName, LucideIcon> = {
  activity: Activity, "alert-triangle": TriangleAlert, archive: Archive, "arrow-down": ArrowDown,
  "arrow-right": ArrowRight, "arrow-up": ArrowUp, "bar-chart": ChartBar, battery: Battery, "book-open": BookOpen,
  bug: Bug, calendar: Calendar, camera: Camera, check: Check, "circle-alert": CircleAlert, "circle-check": CircleCheck,
  "circle-x": CircleX, clock: Clock, cloud: Cloud, code: Code, coffee: Coffee, cpu: Cpu, "credit-card": CreditCard,
  database: Database, "dollar-sign": DollarSign, download: Download, "file-text": FileText, flag: Flag, folder: Folder,
  "git-branch": GitBranch, globe: Globe, "graduation-cap": GraduationCap, heart: Heart, home: House, image: Image,
  info: Info, leaf: Leaf, lightbulb: Lightbulb, "line-chart": ChartLine, link: Link, lock: Lock, mail: Mail,
  "map-pin": MapPin, "message-square": MessageSquare, minus: Minus, moon: Moon, music: Music, package: Package,
  phone: Phone, "pie-chart": ChartPie, plus: Plus, rocket: Rocket, search: Search, server: Server, settings: Settings,
  shield: Shield, "shopping-cart": ShoppingCart, sparkles: Sparkles, star: Star, sun: Sun, target: Target,
  terminal: Terminal, "thumbs-down": ThumbsDown, "thumbs-up": ThumbsUp, timer: Timer, "trending-down": TrendingDown,
  "trending-up": TrendingUp, truck: Truck, upload: Upload, user: User, users: Users, video: Video, wifi: Wifi,
  wrench: Wrench, x: X, zap: Zap,
};

function iconFor(name: unknown, className = "size-4"): React.ReactNode {
  const Icon = typeof name === "string" ? ICONS[name as AidenUiIconName] : undefined;
  return Icon ? <Icon aria-hidden="true" className={cn("shrink-0", className)} /> : null;
}

const TONE_CLASS: Record<string, string> = {
  primary: "text-primary",
  secondary: "text-secondary",
  tertiary: "text-tertiary",
};

/** Spacing steps reuse the theme's spacing unit; the step count is structure. */
function gapStyle(value: unknown, fallback: number): React.CSSProperties {
  const steps = Math.min(Math.max(Math.round(asNumber(value, fallback)), 0), 8);
  return { gap: `calc(var(--spacing) * ${steps})` };
}

function textContent(nodes: readonly AidenUiNodeV1[] | undefined): string {
  return (nodes ?? []).map((node) => (node.t === "#text" ? node.s ?? "" : textContent(node.c))).join("");
}

function read(node: AidenUiNodeV1, ctx: AidenUiRenderContext, name: string): unknown {
  return readProp(node, name, ctx.scope);
}

function bindKey(node: AidenUiNodeV1, ctx: AidenUiRenderContext): string {
  return asString(read(node, ctx, "bind"));
}

function useLabelId(): string {
  return React.useId();
}

const Stack: CatalogComponent = ({ node, ctx }) => {
  const align = asString(read(node, ctx, "align"));
  return (
    <div
      className={cn("flex min-w-0 flex-col", align === "center" ? "items-center" : align === "end" ? "items-end" : align === "start" ? "items-start" : "items-stretch")}
      style={gapStyle(read(node, ctx, "gap"), 3)}
    >
      {ctx.renderChildren(node.c)}
    </div>
  );
};

const Row: CatalogComponent = ({ node, ctx }) => {
  const align = asString(read(node, ctx, "align"));
  const justify = asString(read(node, ctx, "justify"));
  const wrap = read(node, ctx, "wrap");
  return (
    <div
      className={cn(
        "flex min-w-0",
        wrap === false ? "flex-nowrap" : "flex-wrap",
        align === "start" ? "items-start" : align === "end" ? "items-end" : align === "stretch" ? "items-stretch" : "items-center",
        justify === "center" ? "justify-center" : justify === "end" ? "justify-end" : justify === "between" ? "justify-between" : "justify-start",
        "[&>*]:min-w-0 [&>*]:flex-1",
      )}
      style={gapStyle(read(node, ctx, "gap"), 3)}
    >
      {ctx.renderChildren(node.c)}
    </div>
  );
};

const Grid: CatalogComponent = ({ node, ctx }) => {
  const columns = Math.min(Math.max(Math.round(asNumber(read(node, ctx, "columns"), 2)), 1), 6);
  const minWidth = Math.min(Math.max(asNumber(read(node, ctx, "minWidth"), 180), 80), 600);
  const gap = gapStyle(read(node, ctx, "gap"), 3);
  return (
    <div
      className="grid min-w-0"
      style={{
        ...gap,
        // At most `columns` tracks; tracks wrap below `minWidth`.
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, max(${minWidth}px, (100% - ${columns - 1} * ${gap.gap}) / ${columns})), 1fr))`,
      }}
    >
      {ctx.renderChildren(node.c)}
    </div>
  );
};

const CARD_TONE: Record<string, string> = {
  accent: "bg-status-accent-surface",
  green: "bg-status-green-surface",
  red: "bg-status-red-surface",
  warning: "bg-status-warning-surface",
};

const Card: CatalogComponent = ({ node, ctx }) => {
  const title = asString(read(node, ctx, "title"));
  return (
    <section className={cn("flex min-w-0 flex-col gap-2 rounded-card bg-well p-3", CARD_TONE[asString(read(node, ctx, "tone"))])}>
      {title ? <h4 className="m-0 text-small-strong text-primary">{title}</h4> : null}
      {ctx.renderChildren(node.c)}
    </section>
  );
};

const Section: CatalogComponent = ({ node, ctx }) => {
  const title = asString(read(node, ctx, "title"));
  const description = asString(read(node, ctx, "description"));
  return (
    <section className="flex min-w-0 flex-col gap-2">
      {title || description ? (
        <header className="flex flex-col gap-0.5">
          {title ? <h3 className="m-0 text-large-strong text-primary">{title}</h3> : null}
          {description ? <p className="m-0 text-small text-secondary">{description}</p> : null}
        </header>
      ) : null}
      {ctx.renderChildren(node.c)}
    </section>
  );
};

const TEXT_SIZE: Record<string, string> = { small: "text-small", regular: "text-regular", large: "text-large-strong" };

const Text: CatalogComponent = ({ node, ctx }) => (
  <p
    className={cn(
      "m-0 min-w-0 break-words",
      TEXT_SIZE[asString(read(node, ctx, "size"))] ?? "text-regular",
      TONE_CLASS[asString(read(node, ctx, "tone"))] ?? "text-primary",
      read(node, ctx, "weight") === "strong" && "font-semibold",
    )}
  >
    {ctx.renderChildren(node.c)}
  </p>
);

const Heading: CatalogComponent = ({ node, ctx }) => {
  const level = asString(read(node, ctx, "level")) || "2";
  const Tag = level === "1" ? "h2" : level === "3" ? "h4" : "h3";
  const size = level === "1" ? "text-heading1" : level === "3" ? "text-large-strong" : "text-heading2";
  return <Tag className={cn("m-0 min-w-0 font-semibold text-primary", size)}>{ctx.renderChildren(node.c)}</Tag>;
};

const MarkdownBlock: CatalogComponent = ({ node }) => <Markdown content={textContent(node.c)} />;

const CodeComponent: CatalogComponent = ({ node, ctx }) => (
  <CodeBlock code={textContent(node.c)} lang={asString(read(node, ctx, "lang")) || undefined} />
);

const MathComponent: CatalogComponent = ({ node, ctx }) => {
  const tex = textContent(node.c).trim();
  if (!tex) return null;
  return read(node, ctx, "display") === true ? <Markdown content={`$$\n${tex}\n$$`} /> : <MarkdownInline content={`$${tex}$`} />;
};

const KbdComponent: CatalogComponent = ({ node, ctx }) => <Kbd>{ctx.renderChildren(node.c)}</Kbd>;

const StatComponent: CatalogComponent = ({ node, ctx }) => {
  const format = read(node, ctx, "format");
  const currency = asString(read(node, ctx, "currency"));
  const value = read(node, ctx, "value");
  const display =
    format === "currency" && /^[A-Z]{3}$/u.test(currency)
      ? new Intl.NumberFormat(navigator.language || "en-US", { style: "currency", currency }).format(asNumber(value, 0))
      : formatCell(value, format);
  const trend = read(node, ctx, "trend");
  return (
    <Stat
      label={asString(read(node, ctx, "label"))}
      value={display}
      caption={asString(read(node, ctx, "caption")) || undefined}
      trend={typeof trend === "number" && Number.isFinite(trend) ? trend : undefined}
    />
  );
};

const TableComponent: CatalogComponent = ({ node, ctx }) => {
  const rows = read(node, ctx, "rows");
  const list = Array.isArray(rows) ? rows.slice(0, 200).map(asRecord) : [];
  const rawColumns = read(node, ctx, "columns");
  const columns = Array.isArray(rawColumns) && rawColumns.length
    ? rawColumns.map(asRecord).map((column) => ({
        key: asString(column.key),
        label: asString(column.label) || asString(column.key),
        format: column.format,
        align: column.align === "end" || (column.format && column.format !== "text" && column.format !== "date") ? ("end" as const) : ("start" as const),
      })).filter((column) => column.key)
    : Object.keys(list[0] ?? {}).map((key) => ({
        key,
        label: key,
        format: undefined,
        align: typeof list[0]?.[key] === "number" ? ("end" as const) : ("start" as const),
      }));
  return (
    <DataTable
      caption={asString(read(node, ctx, "caption")) || undefined}
      columns={columns.map(({ key, label, align }) => ({ key, label, align }))}
      rows={list.map((row) =>
        Object.fromEntries(columns.map((column) => [column.key, formatCell(row[column.key], column.format)])),
      )}
    />
  );
};

const KeyValue: CatalogComponent = ({ node, ctx }) => {
  const items = read(node, ctx, "items");
  const list = Array.isArray(items) ? items.slice(0, 100).map(asRecord) : [];
  return (
    <dl className="m-0 grid min-w-0 grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-small">
      {list.map((item, index) => (
        <React.Fragment key={index}>
          <dt className="text-secondary">{asString(item.label)}</dt>
          <dd className="m-0 text-right tabular-nums text-primary">{asString(item.value)}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
};

const List: CatalogComponent = ({ node, ctx }) => (
  <ul className="m-0 flex min-w-0 list-none flex-col p-0 [&>li:not(:last-child)]:border-b [&>li]:border-separator">
    {ctx.renderChildren(node.c)}
  </ul>
);

const ListRow: CatalogComponent = ({ node, ctx }) => {
  const action = node.p?.action;
  const title = asString(read(node, ctx, "title"));
  const description = asString(read(node, ctx, "description"));
  const meta = asString(read(node, ctx, "meta"));
  const body = (
    <>
      {iconFor(read(node, ctx, "icon"), "size-4 text-secondary")}
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-regular text-primary">{title}</span>
        {description ? <span className="truncate text-small text-secondary">{description}</span> : null}
      </span>
      {meta ? <span className="shrink-0 text-small text-tertiary">{meta}</span> : null}
    </>
  );
  return (
    <li className="min-w-0">
      {isAction(action) ? (
        <Button
          variant="transparent"
          className="h-auto w-full justify-start gap-3 px-2 py-2"
          disabled={ctx.draft}
          onClick={() => ctx.runAction(action, ctx.scope)}
        >
          {body}
        </Button>
      ) : (
        <div className="flex min-w-0 items-center gap-3 px-2 py-2">{body}</div>
      )}
    </li>
  );
};

const BadgeComponent: CatalogComponent = ({ node, ctx }) => {
  const color = asString(read(node, ctx, "color")) as BadgeColor;
  return (
    <Badge color={color || "gray"} icon={iconFor(read(node, ctx, "icon"), "size-3")}>
      {ctx.renderChildren(node.c)}
    </Badge>
  );
};

const CalloutComponent: CatalogComponent = ({ node, ctx }) => {
  const title = asString(read(node, ctx, "title"));
  return (
    <Callout color={asString(read(node, ctx, "color")) || undefined}>
      {title ? <p className="m-0 text-small-strong">{title}</p> : null}
      <div className="flex min-w-0 flex-col gap-1 text-small">{ctx.renderChildren(node.c)}</div>
    </Callout>
  );
};

const ProgressComponent: CatalogComponent = ({ node, ctx }) => {
  const label = asString(read(node, ctx, "label")) || "Progress";
  const max = Math.max(asNumber(read(node, ctx, "max"), 100), 1);
  const value = asNumber(read(node, ctx, "value"), 0);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex justify-between gap-2 text-small">
        <span className="text-secondary">{label}</span>
        <span className="tabular-nums text-primary">{`${formatCell(value, "number")} of ${formatCell(max, "number")}`}</span>
      </div>
      <Progress label={label} value={(value / max) * 100} />
    </div>
  );
};

const Checklist: CatalogComponent = ({ node, ctx }) => {
  const items = read(node, ctx, "items");
  const list = Array.isArray(items) ? items.slice(0, 100).map(asRecord) : [];
  return (
    <ul className="m-0 flex min-w-0 list-none flex-col gap-1.5 p-0">
      {list.map((item, index) => {
        const done = truthy(item.done);
        return (
          <li key={index} className="flex min-w-0 items-start gap-2 text-regular">
            {done ? (
              <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-green" />
            ) : (
              <Circle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-tertiary" />
            )}
            <span className={cn("min-w-0", done ? "text-secondary" : "text-primary")}>
              <span className="sr-only">{done ? "Done: " : "To do: "}</span>
              {asString(item.label)}
            </span>
          </li>
        );
      })}
    </ul>
  );
};

const Timeline: CatalogComponent = ({ node, ctx }) => {
  const items = read(node, ctx, "items");
  const list = Array.isArray(items) ? items.slice(0, 100).map(asRecord) : [];
  return (
    <ol className="m-0 flex min-w-0 list-none flex-col p-0">
      {list.map((item, index) => (
        <li key={index} className="relative flex min-w-0 gap-3 pb-3 last:pb-0">
          <span className="flex w-3 shrink-0 flex-col items-center" aria-hidden="true">
            <span className="mt-1.5 size-2 rounded-full bg-accent" />
            {index < list.length - 1 ? <span className="mt-1 w-px flex-1 bg-separator" /> : null}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-regular text-primary">
              {asString(item.title)}
              {item.time ? <span className="ml-2 text-small text-tertiary">{asString(item.time)}</span> : null}
            </span>
            {item.description ? <span className="text-small text-secondary">{asString(item.description)}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
};

const ImageComponent: CatalogComponent = ({ node, ctx }) => {
  const alt = asString(read(node, ctx, "alt"));
  const source = ctx.attachmentSource(asString(read(node, ctx, "attachment")));
  if (!source) return <p className="m-0 text-small text-secondary">{alt}</p>;
  return <img src={source} alt={alt} className="block max-h-96 max-w-full rounded-card object-contain" />;
};

const IconComponent: CatalogComponent = ({ node, ctx }) => (
  <span className={cn("inline-flex align-middle", TONE_CLASS[asString(read(node, ctx, "tone"))] ?? "text-secondary")}>
    {iconFor(read(node, ctx, "name"))}
  </span>
);

const LinkCard: CatalogComponent = ({ node, ctx }) => {
  const url = asString(read(node, ctx, "url"));
  const title = asString(read(node, ctx, "title"));
  const description = asString(read(node, ctx, "description"));
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = "";
  }
  return (
    <Button
      variant="muted"
      className="h-auto w-full justify-start gap-3 px-3 py-2.5"
      disabled={ctx.draft || !url.startsWith("https://")}
      onClick={() => ctx.runAction({ act: "open", url: { op: "lit", v: url } }, ctx.scope)}
    >
      <Link aria-hidden="true" className="size-4 shrink-0 text-secondary" />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-regular text-primary">{title}</span>
        <span className="truncate text-small text-secondary">{description || host}</span>
      </span>
    </Button>
  );
};

const ChartComponent: CatalogComponent = ({ node, ctx }) => (
  <AidenUiChart
    kind={(asString(read(node, ctx, "kind")) || "bar") as ChartProps["kind"]}
    data={read(node, ctx, "data")}
    x={asString(read(node, ctx, "x"))}
    y={read(node, ctx, "y")}
    series={read(node, ctx, "series")}
    height={asNumber(read(node, ctx, "height"), 220)}
    stacked={read(node, ctx, "stacked") === true}
    format={read(node, ctx, "format")}
    label={asString(read(node, ctx, "label"))}
  />
);

const BarList: CatalogComponent = ({ node, ctx }) => (
  <AidenUiBarList
    items={read(node, ctx, "items")}
    labelKey={asString(read(node, ctx, "label")) || "label"}
    valueKey={asString(read(node, ctx, "value")) || "value"}
    format={read(node, ctx, "format")}
  />
);

const Heatmap: CatalogComponent = ({ node, ctx }) => (
  <AidenUiHeatmap
    rows={read(node, ctx, "rows")}
    x={asString(read(node, ctx, "x")) || "x"}
    y={asString(read(node, ctx, "y")) || "y"}
    value={asString(read(node, ctx, "value")) || "value"}
    label={asString(read(node, ctx, "label"))}
  />
);

const Sparkline: CatalogComponent = ({ node, ctx }) => (
  <AidenUiSparkline
    values={read(node, ctx, "values")}
    height={asNumber(read(node, ctx, "height"), 32)}
    label={asString(read(node, ctx, "label"))}
  />
);

const SegmentedComponent: CatalogComponent = ({ node, ctx }) => {
  const key = bindKey(node, ctx);
  const options = normalizeOptions(read(node, ctx, "options"));
  return (
    <Segmented
      aria-label={asString(read(node, ctx, "label")) || key}
      disabled={ctx.draft}
      value={optionKey(options, ctx.state[key])}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.key === next);
        if (option) ctx.setState(key, option.value);
      }}
      options={options.map((option) => ({ value: option.key, label: option.label }))}
    />
  );
};

const TabsComponent: CatalogComponent = ({ node, ctx }) => {
  const key = bindKey(node, ctx);
  const options = normalizeOptions(read(node, ctx, "options"));
  return (
    <Tabs
      aria-label={asString(read(node, ctx, "label")) || key}
      value={optionKey(options, ctx.state[key])}
      onValueChange={(next) => {
        if (ctx.draft) return;
        const option = options.find((candidate) => candidate.key === next);
        if (option) ctx.setState(key, option.value);
      }}
      items={options.map((option) => ({ value: option.key, label: option.label }))}
    />
  );
};

const SwitchComponent: CatalogComponent = ({ node, ctx }) => {
  const key = bindKey(node, ctx);
  const id = useLabelId();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Switch id={id} checked={truthy(ctx.state[key])} disabled={ctx.draft} onCheckedChange={(next) => ctx.setState(key, next)} />
      <label htmlFor={id} className="min-w-0 text-small text-primary">{asString(read(node, ctx, "label"))}</label>
    </div>
  );
};

const CheckboxComponent: CatalogComponent = ({ node, ctx }) => {
  const key = bindKey(node, ctx);
  return (
    <Checkbox
      checked={truthy(ctx.state[key])}
      disabled={ctx.draft}
      onCheckedChange={(next) => ctx.setState(key, next)}
      label={asString(read(node, ctx, "label"))}
    />
  );
};

const RadioGroupComponent: CatalogComponent = ({ node, ctx }) => {
  const key = bindKey(node, ctx);
  const options = normalizeOptions(read(node, ctx, "options"));
  const groupId = useLabelId();
  const label = asString(read(node, ctx, "label"));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label ? <span id={`${groupId}-label`} className="text-small text-secondary">{label}</span> : null}
      <RadioGroup
        aria-labelledby={label ? `${groupId}-label` : undefined}
        aria-label={label ? undefined : key}
        disabled={ctx.draft}
        value={optionKey(options, ctx.state[key])}
        onValueChange={(next) => {
          const option = options.find((candidate) => candidate.key === next);
          if (option) ctx.setState(key, option.value);
        }}
        className="flex-wrap"
      >
        {options.map((option, index) => (
          <div key={option.key} className="flex items-center gap-2">
            <RadioGroupItem id={`${groupId}-${index}`} value={option.key} />
            <label htmlFor={`${groupId}-${index}`} className="text-small text-primary">{option.label}</label>
          </div>
        ))}
      </RadioGroup>
    </div>
  );
};

const SelectComponent: CatalogComponent = ({ node, ctx }) => {
  const key = bindKey(node, ctx);
  const options = normalizeOptions(read(node, ctx, "options"));
  const label = asString(read(node, ctx, "label")) || key;
  return (
    <Select
      value={optionKey(options, ctx.state[key]) || undefined}
      disabled={ctx.draft}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.key === next);
        if (option) ctx.setState(key, option.value);
      }}
    >
      <SelectTrigger aria-label={label} className="min-w-40">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.key} value={option.key}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

const SliderComponent: CatalogComponent = ({ node, ctx }) => {
  const key = bindKey(node, ctx);
  const min = asNumber(read(node, ctx, "min"), 0);
  const max = Math.max(asNumber(read(node, ctx, "max"), 100), min + 1);
  const step = Math.max(asNumber(read(node, ctx, "step"), 1), 0.0001);
  const value = Math.min(Math.max(asNumber(ctx.state[key], min), min), max);
  return (
    <Slider
      label={asString(read(node, ctx, "label")) || key}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={ctx.draft}
      valueLabel={formatCell(value, read(node, ctx, "format"))}
      onValueChange={(next) => ctx.setState(key, next)}
    />
  );
};

const TextInput: CatalogComponent = ({ node, ctx }) => {
  const key = bindKey(node, ctx);
  const id = useLabelId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-small text-secondary">{asString(read(node, ctx, "label"))}</label>
      <Input
        id={id}
        value={asString(ctx.state[key])}
        placeholder={asString(read(node, ctx, "placeholder")) || undefined}
        disabled={ctx.draft}
        maxLength={500}
        onChange={(event) => ctx.setState(key, event.currentTarget.value)}
      />
    </div>
  );
};

const BUTTON_VARIANTS = new Set(["accent", "filled", "muted", "transparent"]);

const ButtonComponent: CatalogComponent = ({ node, ctx }) => {
  const action = node.p?.action;
  const variant = asString(read(node, ctx, "variant"));
  return (
    <Button
      size="small"
      variant={(BUTTON_VARIANTS.has(variant) ? variant : "filled") as "accent"}
      disabled={ctx.draft || !isAction(action)}
      onClick={() => {
        if (isAction(action)) ctx.runAction(action, ctx.scope);
      }}
    >
      {iconFor(read(node, ctx, "icon"), "size-3.5")}
      {ctx.renderChildren(node.c)}
    </Button>
  );
};

const ButtonGroup: CatalogComponent = ({ node, ctx }) => (
  <div className="flex min-w-0 flex-wrap items-center gap-2">{ctx.renderChildren(node.c)}</div>
);

const DisclosureComponent: CatalogComponent = ({ node, ctx }) => (
  <Disclosure title={asString(read(node, ctx, "title"))} defaultOpen={read(node, ctx, "open") === true}>
    <div className="flex min-w-0 flex-col gap-2">{ctx.renderChildren(node.c)}</div>
  </Disclosure>
);

const TooltipComponent: CatalogComponent = ({ node, ctx }) => (
  <Tooltip content={asString(read(node, ctx, "content"))}>
    <span tabIndex={0} className="inline-flex min-w-0 rounded-menu">
      {ctx.renderChildren(node.c)}
    </span>
  </Tooltip>
);

const SeparatorComponent: CatalogComponent = () => <Separator />;

const Spacer: CatalogComponent = ({ node, ctx }) => {
  const steps = Math.min(Math.max(Math.round(asNumber(read(node, ctx, "size"), 2)), 0), 12);
  return <div aria-hidden="true" style={{ height: `calc(var(--spacing) * ${steps})` }} />;
};

export const CATALOG_COMPONENTS: Readonly<Record<string, CatalogComponent>> = {
  Stack, Row, Grid, Card, Section, Separator: SeparatorComponent, Spacer,
  Text, Heading, Markdown: MarkdownBlock, Code: CodeComponent, Math: MathComponent, Kbd: KbdComponent,
  Stat: StatComponent, Table: TableComponent, KeyValue, List, ListRow, Badge: BadgeComponent, Callout: CalloutComponent,
  Progress: ProgressComponent, Meter: ProgressComponent, Checklist, Timeline, Image: ImageComponent, Icon: IconComponent, LinkCard,
  Chart: ChartComponent, BarList, Heatmap, Sparkline,
  Segmented: SegmentedComponent, Tabs: TabsComponent, Switch: SwitchComponent, Checkbox: CheckboxComponent,
  RadioGroup: RadioGroupComponent, Select: SelectComponent, Slider: SliderComponent, TextInput,
  Button: ButtonComponent, ButtonGroup, Disclosure: DisclosureComponent, Tooltip: TooltipComponent,
};
