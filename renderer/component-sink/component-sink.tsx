// Component sink: every shared primitive in its states on one page, with a
// toolbar for the theme preset and light or dark. Development only: the Vite
// dev server serves it at /component-sink.html, and the production build has
// no entry for that page, so nothing in the packaged app can reach it.

import * as React from "react";
import { Bell, Copy, LoaderCircle, Palette, Plus, Trash2 } from "lucide-react";
import {
  AidenIcon,
  AlertDialog,
  Badge,
  Button,
  Callout,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Dialog,
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
  EmptyState,
  ErrorBoundaryView,
  Field,
  FieldSet,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  InlineMetadata,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  SettingsDisclosure,
  SidebarList,
  SidebarListGroup,
  SidebarListItem,
  Status,
  Switch,
  Text,
  Textarea,
  Toaster,
  TooltipProvider,
  toast,
  type BadgeColor,
} from "../components/ui";
import {
  Checkbox,
  DataTable,
  Disclosure,
  Kbd,
  Progress,
  Segmented,
  Slider,
  Stat,
  Tabs,
  Tooltip,
} from "../components/ui-primitives";
import { InfoHint } from "../components/ui-info-hint";
import { SettingsPage, SettingsPageTabs } from "../components/settings/settings-page";
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearanceConfig,
  effectiveAppearanceScheme,
  readCachedAppearance,
} from "../lib/appearance-runtime";
import { SETTINGS_PAGES, type SettingsSection } from "../lib/settings-section";
import {
  createDefaultAppearanceConfig,
  getPresetVariant,
  THEME_PRESETS,
  type AppearanceScheme,
  type ThemePresetId,
} from "../shared/appearance";

const BUTTON_VARIANTS = [
  "filled",
  "muted",
  "transparent",
  "glass",
  "toolbar",
  "bar",
  "glassAccent",
  "accent",
  "destructive",
] as const;
const BADGE_COLORS: readonly BadgeColor[] = ["gray", "green", "red", "blue", "warning"];

/**
 * Applies a preset and scheme through the app's own `applyAppearanceConfig`.
 * That call also caches what it applies, so the cached value is put back
 * afterwards and the sink never changes this origin's saved appearance.
 */
function applySinkAppearance(preset: ThemePresetId, scheme: AppearanceScheme): void {
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(APPEARANCE_STORAGE_KEY);
  } catch {
    // Storage is unavailable: nothing to put back.
  }
  const base = readCachedAppearance() ?? createDefaultAppearanceConfig();
  applyAppearanceConfig({ ...base, mode: scheme, [scheme]: getPresetVariant(preset, scheme) });
  try {
    if (cached === null) localStorage.removeItem(APPEARANCE_STORAGE_KEY);
    else localStorage.setItem(APPEARANCE_STORAGE_KEY, cached);
  } catch {
    // Same as above.
  }
}

function initialAppearance(): { preset: ThemePresetId; scheme: AppearanceScheme } {
  const config = readCachedAppearance() ?? createDefaultAppearanceConfig();
  const scheme = effectiveAppearanceScheme(config);
  const preset = config[scheme].preset;
  return { scheme, preset: preset === "custom" ? "aiden" : preset };
}

/** One labelled group of cases. */
function SinkSection({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return (
    <section aria-labelledby={`sink-${title}`} className="flex flex-col gap-4">
      <h2 id={`sink-${title}`} className="text-heading2 font-semibold text-primary">
        {title}
      </h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{children}</div>
    </section>
  );
}

/**
 * One case. `covers` lists the shared exports it shows, space-separated, in
 * `data-sink`; the sink test checks it against the modules' real exports.
 */
function SinkCase({ covers, title, children }: React.PropsWithChildren<{ covers: string; title: string }>) {
  return (
    <div data-sink={covers} className="flex min-w-0 flex-col gap-3 rounded-card bg-well p-4">
      <Text variant="small-strong" color="secondary">
        {title}
      </Text>
      <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function Toolbar({
  preset,
  scheme,
  onPreset,
  onScheme,
}: {
  preset: ThemePresetId;
  scheme: AppearanceScheme;
  onPreset: (preset: ThemePresetId) => void;
  onScheme: (scheme: AppearanceScheme) => void;
}) {
  const label = THEME_PRESETS.find((entry) => entry.id === preset)?.label ?? preset;
  return (
    <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 bg-background px-6 py-3 shadow-control">
      <AidenIcon />
      <Text variant="strong">Component sink</Text>
      <InlineMetadata>Development only</InlineMetadata>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="filled" size="small" aria-label={`Theme preset: ${label}`}>
              <Palette aria-hidden="true" />
              {label}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Theme preset</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={preset} onValueChange={(next) => onPreset(next as ThemePresetId)}>
              {THEME_PRESETS.map((entry) => (
                <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                  {entry.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Segmented
          aria-label="Scheme"
          value={scheme}
          onValueChange={onScheme}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </div>
    </header>
  );
}

function ButtonCases() {
  return (
    <>
      <SinkCase covers="Button" title="Variants: rest, disabled, loading">
        <div className="grid w-full grid-cols-[auto_repeat(3,max-content)] items-center gap-x-3 gap-y-2">
          {BUTTON_VARIANTS.map((variant) => (
            <React.Fragment key={variant}>
              <InlineMetadata>{variant}</InlineMetadata>
              <Button variant={variant}>Save</Button>
              <Button variant={variant} disabled>
                Save
              </Button>
              <Button variant={variant} disabled aria-busy="true">
                <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Saving…
              </Button>
            </React.Fragment>
          ))}
        </div>
      </SinkCase>
      <SinkCase covers="Button" title="Sizes, icon-only, link">
        <Button size="small">Small</Button>
        <Button size="medium">Medium</Button>
        <Button size="large">Large</Button>
        <Button iconOnly aria-label="Add">
          <Plus aria-hidden="true" />
        </Button>
        <Button iconOnly variant="bar" size="small" aria-label="Notifications" aria-pressed="true">
          <Bell aria-hidden="true" />
        </Button>
        <Button pressFeedback variant="accent">
          Press feedback
        </Button>
        <Button asChild variant="transparent">
          <a href="#sink-Buttons">Button link</a>
        </Button>
      </SinkCase>
    </>
  );
}

function InputCases() {
  const [select, setSelect] = React.useState("balanced");
  return (
    <>
      <SinkCase covers="Input Label" title="Input: empty, filled, disabled, invalid">
        <div className="grid w-full grid-cols-1 gap-2">
          <Label htmlFor="sink-input-empty">Empty</Label>
          <Input id="sink-input-empty" placeholder="Search chats" />
          <Input aria-label="Filled" defaultValue="Weekly report" />
          <Input aria-label="Disabled" defaultValue="Read only" disabled />
          <Input aria-label="Invalid" defaultValue="not a url" aria-invalid="true" />
        </div>
      </SinkCase>
      <SinkCase covers="Textarea" title="Textarea: empty, filled, compact, disabled, invalid">
        <div className="grid w-full grid-cols-1 gap-2">
          <Textarea aria-label="Empty textarea" placeholder="Add instructions" />
          <Textarea aria-label="Filled textarea" defaultValue={"Line one\nLine two"} />
          <Textarea aria-label="Compact textarea" density="compact" placeholder="Compact" />
          <Textarea aria-label="Disabled textarea" defaultValue="Read only" disabled />
          <Textarea aria-label="Invalid textarea" defaultValue="Too long" aria-invalid="true" />
        </div>
      </SinkCase>
      <SinkCase covers="Select SelectTrigger SelectValue SelectContent SelectItem" title="Select: default, small, disabled">
        <div className="grid w-full grid-cols-1 gap-2">
          <Select value={select} onValueChange={setSelect}>
            <SelectTrigger aria-label="Thinking">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fast">Fast</SelectItem>
              <SelectItem value="balanced">Balanced</SelectItem>
              <SelectItem value="deep">Deep</SelectItem>
              <SelectItem value="off" disabled>
                Off (unavailable)
              </SelectItem>
            </SelectContent>
          </Select>
          <Select defaultValue="end">
            <SelectTrigger size="small" aria-label="Path format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="end">End</SelectItem>
              <SelectItem value="middle">Middle</SelectItem>
            </SelectContent>
          </Select>
          <Select defaultValue="end" disabled>
            <SelectTrigger aria-label="Disabled select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="end">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </SinkCase>
    </>
  );
}

function ChoiceCases() {
  const [checked, setChecked] = React.useState(true);
  const [segment, setSegment] = React.useState<"all" | "active" | "paused">("all");
  const [tab, setTab] = React.useState<"general" | "advanced">("general");
  const [slider, setSlider] = React.useState(40);
  return (
    <>
      <SinkCase covers="Switch" title="Switch: off, on, disabled">
        <Switch aria-label="Off" />
        <Switch aria-label="On" defaultChecked />
        <Switch aria-label="Disabled off" disabled />
        <Switch aria-label="Disabled on" defaultChecked disabled />
      </SinkCase>
      <SinkCase covers="Checkbox" title="Checkbox: off, on, disabled">
        <Checkbox label="Unchecked" checked={false} onCheckedChange={() => undefined} />
        <Checkbox label="Toggle me" checked={checked} onCheckedChange={setChecked} />
        <Checkbox label="Disabled" checked disabled onCheckedChange={() => undefined} />
      </SinkCase>
      <SinkCase covers="RadioGroup RadioGroupItem" title="Radio: vertical, disabled item">
        <RadioGroup defaultValue="queue" orientation="vertical" aria-label="Busy sends">
          {[
            { value: "queue", label: "Queue" },
            { value: "steer", label: "Steer" },
            { value: "off", label: "Unavailable", disabled: true },
          ].map((item) => (
            <Label key={item.value}>
              <RadioGroupItem value={item.value} disabled={item.disabled} />
              {item.label}
            </Label>
          ))}
        </RadioGroup>
      </SinkCase>
      <SinkCase covers="Segmented Tabs" title="Segmented, Tabs">
        <Segmented
          aria-label="Filter"
          value={segment}
          onValueChange={setSegment}
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "paused", label: "Paused" },
          ]}
        />
        <Segmented aria-label="Disabled filter" disabled value="all" onValueChange={() => undefined} options={[{ value: "all", label: "Disabled" }]} />
        <Tabs
          aria-label="Sections"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: "general", label: "General" },
            { value: "advanced", label: "Advanced" },
          ]}
        />
      </SinkCase>
      <SinkCase covers="Slider Progress" title="Slider, Progress">
        <div className="grid w-full grid-cols-1 gap-3">
          <Slider label="Volume" value={slider} onValueChange={setSlider} valueLabel={`${slider}%`} />
          <Slider label="Disabled" value={60} disabled onValueChange={() => undefined} />
          <Progress label="Download" value={65} />
          <Progress label="Preparing" indeterminate />
        </div>
      </SinkCase>
    </>
  );
}

function StatusCases() {
  return (
    <>
      <SinkCase covers="Badge" title="Badge: every color, with and without icon">
        {BADGE_COLORS.map((color) => (
          <Badge key={color} color={color}>
            {color}
          </Badge>
        ))}
        {BADGE_COLORS.map((color) => (
          <Badge key={`${color}-icon`} color={color} icon={<Bell />}>
            {color}
          </Badge>
        ))}
      </SinkCase>
      <SinkCase covers="Status" title="Status: default, error">
        <Status>Connected</Status>
        <Status variant="error">Failed</Status>
      </SinkCase>
      <SinkCase covers="Callout" title="Callout: neutral and status fills">
        <div className="grid w-full grid-cols-1 gap-2">
          {([undefined, "blue", "green", "warning", "red"] as const).map((color) => (
            <Callout key={color ?? "neutral"} color={color}>
              <Text variant="small-strong" className="text-current">
                {color ?? "neutral"}
              </Text>
              <Text variant="small" className="text-current">
                A short explanation of what happened.
              </Text>
            </Callout>
          ))}
        </div>
      </SinkCase>
      <SinkCase covers="EmptyState Stat" title="EmptyState, Stat">
        <EmptyState
          placement="inline"
          title="No chats yet"
          description="Start one from the message box."
          action={<Button variant="accent">New chat</Button>}
        />
        <Stat label="Tokens" value="12.4k" trend={0.12} caption="this week" />
        <Stat label="Errors" value="3" trend={-0.4} />
      </SinkCase>
      <SinkCase covers="ErrorBoundaryView" title="ErrorBoundaryView (full-window crash screen, clipped)">
        <div className="h-56 w-full overflow-hidden rounded-card bg-background [&>div]:h-full">
          <ErrorBoundaryView error={new Error("Example failure")} reset={() => undefined} />
        </div>
      </SinkCase>
    </>
  );
}

function TypeCases() {
  return (
    <SinkCase covers="Text InlineMetadata Kbd Separator AidenIcon" title="Text, metadata, keys, separator, icon">
      <div className="flex w-full flex-col gap-1">
        {(["heading1", "strong", "regular", "small", "small-strong"] as const).map((variant) => (
          <Text key={variant} variant={variant}>
            {variant}
          </Text>
        ))}
        <div className="flex flex-wrap gap-3">
          {(["primary", "secondary", "tertiary", "quaternary", "red", "status-red"] as const).map((color) => (
            <Text key={color} color={color}>
              {color}
            </Text>
          ))}
        </div>
        <InlineMetadata>Edited 2 minutes ago</InlineMetadata>
        <Separator className="my-2" />
        <div className="flex items-center gap-2">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
          <Separator orientation="vertical" className="h-4" />
          <AidenIcon />
        </div>
      </div>
    </SinkCase>
  );
}

function OverlayCases() {
  const [dialog, setDialog] = React.useState<"plain" | "busy" | "blocked" | null>(null);
  const [alert, setAlert] = React.useState(false);
  const [pinned, setPinned] = React.useState(true);
  const [sort, setSort] = React.useState("recent");
  return (
    <>
      <SinkCase covers="Tooltip InfoHint HoverCard HoverCardTrigger HoverCardContent" title="Tooltip, InfoHint, HoverCard">
        <Tooltip content="Copy link">
          <Button iconOnly aria-label="Copy link">
            <Copy aria-hidden="true" />
          </Button>
        </Tooltip>
        <InfoHint topic="context usage">How much of the model's context this chat uses.</InfoHint>
        <HoverCard openDelay={200}>
          <HoverCardTrigger asChild>
            <Button variant="transparent">Hover for details</Button>
          </HoverCardTrigger>
          <HoverCardContent>
            <Text variant="strong">Claude</Text>
            <Text as="p" variant="small" color="secondary">
              A hover card with a short summary.
            </Text>
          </HoverCardContent>
        </HoverCard>
      </SinkCase>
      <SinkCase covers="Popover PopoverTrigger PopoverContent" title="Popover">
        <Popover>
          <PopoverTrigger asChild>
            <Button>Open popover</Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-3">
            <Text variant="small">Popover content with a control.</Text>
            <Input aria-label="Popover field" className="mt-2" placeholder="Name" />
          </PopoverContent>
        </Popover>
      </SinkCase>
      <SinkCase
        covers="DropdownMenu DropdownMenuTrigger DropdownMenuContent DropdownMenuLabel DropdownMenuItem DropdownMenuSeparator DropdownMenuCheckboxItem DropdownMenuRadioGroup DropdownMenuRadioItem DropdownMenuSub DropdownMenuSubTrigger DropdownMenuSubContent"
        title="Dropdown menu: items, disabled, destructive, check, radio, submenu"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>Open menu</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Chat</DropdownMenuLabel>
            <DropdownMenuItem>Rename</DropdownMenuItem>
            <DropdownMenuItem disabled>Share (unavailable)</DropdownMenuItem>
            <DropdownMenuCheckboxItem checked={pinned} onCheckedChange={setPinned} sublabel="Keeps it at the top">
              Pinned
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
              <DropdownMenuRadioItem value="recent">Recent first</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="name">By name</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Inbox</DropdownMenuItem>
                <DropdownMenuItem>Archive</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem color="red">
              <Trash2 aria-hidden="true" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SinkCase>
      <SinkCase
        covers="ContextMenu ContextMenuTrigger ContextMenuContent ContextMenuItem ContextMenuSeparator ContextMenuSub ContextMenuSubTrigger ContextMenuSubContent"
        title="Context menu"
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="grid h-16 w-full place-items-center rounded-card bg-control text-small text-secondary">
              Right-click here
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Open</ContextMenuItem>
            <ContextMenuItem disabled>Duplicate (unavailable)</ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>Share</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem>Copy link</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuItem>Remove</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </SinkCase>
      <SinkCase covers="Dialog AlertDialog" title="Dialog: plain, busy, confirm off; destructive alert">
        <Button onClick={() => setDialog("plain")}>Open dialog</Button>
        <Button onClick={() => setDialog("busy")}>Busy dialog</Button>
        <Button onClick={() => setDialog("blocked")}>Confirm off</Button>
        <Button variant="destructive" onClick={() => setAlert(true)}>
          Delete…
        </Button>
        <Dialog
          open={dialog !== null}
          onOpenChange={(open) => !open && setDialog(null)}
          title="Rename chat"
          description="Names show in the sidebar and the palette."
          confirmLabel="Rename"
          busy={dialog === "busy"}
          allowCancelWhileBusy
          confirmDisabled={dialog === "blocked"}
          submitOnEnter
          onConfirm={() => setDialog(null)}
        >
          <Input aria-label="Chat name" defaultValue="Weekly report" />
        </Dialog>
        <AlertDialog
          open={alert}
          onOpenChange={setAlert}
          title="Delete this chat?"
          description="This can't be undone."
          confirmLabel="Delete"
          confirmVariant="destructive"
          onConfirm={() => setAlert(false)}
        />
      </SinkCase>
      <SinkCase covers="Toaster" title="Toasts">
        <Button onClick={() => toast("Copied to clipboard")}>Toast</Button>
        <Button onClick={() => toast.success("Saved")}>Success</Button>
        <Button onClick={() => toast.error("Couldn't save")}>Error</Button>
      </SinkCase>
    </>
  );
}

function ListCases() {
  return (
    <>
      <SinkCase covers="SidebarList SidebarListGroup SidebarListItem" title="Sidebar rows: rest, selected, trailing">
        <SidebarList className="w-full px-0 pb-0">
          <SidebarListGroup title="Today">
            <SidebarListItem title="Selected chat" selected />
            <SidebarListItem icon={<Bell />} title="Chat with an icon" />
            <SidebarListItem title="Chat with trailing" trailing={<Badge color="blue">2</Badge>} />
            <SidebarListItem title="Disabled chat" disabled />
          </SidebarListGroup>
        </SidebarList>
      </SinkCase>
      <SinkCase covers="DataTable Disclosure" title="DataTable, Disclosure">
        <DataTable
          className="w-full"
          caption="Models"
          columns={[
            { key: "model", label: "Model" },
            { key: "tokens", label: "Tokens", align: "end" },
          ]}
          rows={[
            { model: "Fast", tokens: "1,204" },
            { model: "Deep", tokens: "88,310" },
          ]}
        />
        <Disclosure title="Show details">
          <Text variant="small" color="secondary">
            Folded content stays out of the way until opened.
          </Text>
        </Disclosure>
      </SinkCase>
      <SinkCase
        covers="Command CommandInput CommandList CommandEmpty CommandGroup CommandItem CommandSeparator"
        title="Command list in a popover, as the pickers use it"
      >
        {/* Inline, cmdk scrolls its selected row into view on mount and drags the page with it. */}
        <Popover>
          <PopoverTrigger asChild>
            <Button>Open command list</Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-0">
            <Command label="Sink commands">
              <CommandInput placeholder="Type a command" />
              <CommandList>
                <CommandEmpty>No results</CommandEmpty>
                <CommandGroup heading="Chats">
                  <CommandItem>New chat</CommandItem>
                  <CommandItem>Search chats</CommandItem>
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Settings">
                  <CommandItem>Appearance</CommandItem>
                  <CommandItem disabled>Unavailable</CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </SinkCase>
    </>
  );
}

function SettingsCases() {
  const tabbedPage = SETTINGS_PAGES.find((page) => page.tabs.length > 1);
  const [section, setSection] = React.useState<SettingsSection | undefined>(tabbedPage?.tabs[0]);
  return (
    <div data-sink="SettingsPage SettingsPageTabs FieldSet Field SettingsDisclosure" className="settings-responsive min-w-0">
      <SettingsPage title="Settings page" description="The shared heading, grouped cards, rows and folds.">
        {tabbedPage && section ? (
          <SettingsPageTabs page={tabbedPage} section={section} onSelect={setSection}>
            <InlineMetadata>Panel for {section}</InlineMetadata>
          </SettingsPageTabs>
        ) : null}
        <FieldSet
          title="Group"
          hint={<InfoHint topic="this group">A short hint beside the group title.</InfoHint>}
          action={
            <Button size="small" variant="muted">
              Group action
            </Button>
          }
        >
          <Field label="Trailing switch" description="A row with a direct switch keeps it on the right.">
            <Switch aria-label="Trailing switch" defaultChecked />
          </Field>
          <Field label="Text field" hint={<InfoHint topic="text field">Hints sit beside the label.</InfoHint>}>
            <Input aria-label="Text field" placeholder="Value" />
          </Field>
          <Field label="Disabled row" description="Controls show their disabled state.">
            <Switch aria-label="Disabled row" disabled />
          </Field>
          <Field label="Vertical row" description="Editors and lists stack under the label." orientation="vertical">
            <Textarea aria-label="Vertical row" placeholder="Notes" />
          </Field>
        </FieldSet>
        <SettingsDisclosure title="Folded group" summary="Two reference rows inside">
          <Field label="Inside the fold">
            <Button size="small">Action</Button>
          </Field>
        </SettingsDisclosure>
        <SettingsDisclosure title="Fold with a badge" summary="Opens by default" badge={<Badge color="warning">Needs attention</Badge>} defaultOpen>
          <Field label="Visible row">
            <Switch aria-label="Visible row" />
          </Field>
        </SettingsDisclosure>
      </SettingsPage>
    </div>
  );
}

export function ComponentSink() {
  const [appearance, setAppearance] = React.useState(initialAppearance);
  React.useEffect(() => {
    applySinkAppearance(appearance.preset, appearance.scheme);
  }, [appearance]);
  return (
    <TooltipProvider>
      <div className="h-full overflow-y-auto bg-background text-primary">
        <Toolbar
          preset={appearance.preset}
          scheme={appearance.scheme}
          onPreset={(preset) => setAppearance((current) => ({ ...current, preset }))}
          onScheme={(scheme) => setAppearance((current) => ({ ...current, scheme }))}
        />
        <main className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-8">
          <SinkSection title="Buttons">
            <ButtonCases />
          </SinkSection>
          <SinkSection title="Text">
            <TypeCases />
          </SinkSection>
          <SinkSection title="Inputs">
            <InputCases />
          </SinkSection>
          <SinkSection title="Choices">
            <ChoiceCases />
          </SinkSection>
          <SinkSection title="Status">
            <StatusCases />
          </SinkSection>
          <SinkSection title="Overlays">
            <OverlayCases />
          </SinkSection>
          <SinkSection title="Lists">
            <ListCases />
          </SinkSection>
          <section aria-labelledby="sink-Settings" className="flex flex-col gap-4">
            <h2 id="sink-Settings" className="text-heading2 font-semibold text-primary">
              Settings
            </h2>
            <SettingsCases />
          </section>
        </main>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
