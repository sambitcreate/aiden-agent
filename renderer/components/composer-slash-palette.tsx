import * as React from "react";
import {
  Bot,
  Clipboard,
  CopyPlus,
  Code2,
  Download,
  FileSearch,
  FolderCog,
  FolderGit2,
  GitFork,
  Info,
  Keyboard,
  LockKeyhole,
  LogOut,
  MessageSquare,
  MonitorCog,
  Palette,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Server,
  Settings,
  Sparkles,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { cn } from "../lib/ui-utils";
import { slashPalettePresenceState, type SlashResult } from "../lib/slash-command-core";
import type { SlashCommandAvailabilityResult } from "../lib/slash-command-actions";
import type { SlashCommandIcon } from "../shared/slash-commands";

export const COMPOSER_SLASH_PALETTE_ID = "composer-slash-palette";
export const COMPOSER_SLASH_RETRY_ID = "slash-option-skills-retry";
const SLASH_PALETTE_EXIT_MS = 110;

const ICONS: Record<SlashCommandIcon, React.ComponentType<{ className?: string }>> = {
  access: LockKeyhole,
  appearance: Palette,
  assistant: Bot,
  chat: MessageSquare,
  copy: Clipboard,
  clone: CopyPlus,
  editor: Code2,
  environment: FolderCog,
  export: Download,
  fork: GitFork,
  hotkeys: Keyboard,
  mcp: Server,
  model: MonitorCog,
  new: Plus,
  logout: LogOut,
  providers: Wrench,
  rename: Pencil,
  review: FileSearch,
  settings: Settings,
  sidebar: PanelLeft,
  skills: Sparkles,
  session: Info,
  terminal: TerminalSquare,
  worktree: FolderGit2,
};

interface ComposerSlashPaletteProps {
  results: readonly SlashResult[];
  activeId?: string;
  skillsLoading: boolean;
  skillsError: boolean;
  truncated: boolean;
  commandAvailability: (
    result: Extract<SlashResult, { kind: "command" }>,
  ) => SlashCommandAvailabilityResult;
  onActiveIdChange: (id: string) => void;
  onSelect: (result: SlashResult) => void;
  onRetrySkills: () => void;
  skillSelectionEnabled?: boolean;
  presenceState?: "visible" | "exiting";
}

export function ComposerSlashPalettePresence({
  present,
  immediate = false,
  children,
}: {
  present: boolean;
  immediate?: boolean;
  children: React.ReactElement<ComposerSlashPaletteProps> | null;
}) {
  const lastContentRef = React.useRef(children);
  const [retained, setRetained] = React.useState(present);
  React.useLayoutEffect(() => {
    if (present && children) lastContentRef.current = children;
  }, [children, present]);
  const reduceMotion =
    typeof document !== "undefined" && document.documentElement.dataset.reduceMotion === "true";
  const presenceState = slashPalettePresenceState({
    present,
    retained,
    immediate,
    reduceMotion,
  });

  React.useEffect(() => {
    if (present) {
      setRetained(true);
      return;
    }
    if (!retained) return;
    if (immediate || reduceMotion) {
      setRetained(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setRetained(false);
    }, SLASH_PALETTE_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [immediate, present, reduceMotion, retained]);

  if (presenceState === "hidden") return null;
  const content = present ? children : lastContentRef.current;
  return content ? React.cloneElement(content, { presenceState }) : null;
}

function sourceLabel(source: Extract<SlashResult, { kind: "skill" }>["skill"]["source"]): string {
  return source === "configured" ? "Configured" : source === "workspace" ? "Workspace" : "Global";
}

export function ComposerSlashPalette({
  results,
  activeId,
  skillsLoading,
  skillsError,
  truncated,
  commandAvailability,
  onActiveIdChange,
  onSelect,
  onRetrySkills,
  skillSelectionEnabled = false,
  presenceState = "visible",
}: ComposerSlashPaletteProps) {
  const commands = results.filter(
    (result): result is Extract<SlashResult, { kind: "command" }> => result.kind === "command",
  );
  const skills = results.filter(
    (result): result is Extract<SlashResult, { kind: "skill" }> => result.kind === "skill",
  );
  const [announcement, setAnnouncement] = React.useState("");

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const count = commands.length + skills.length;
      setAnnouncement(
        skillsError
          ? "Skills could not be loaded. Navigate to Retry skills to try again."
          : skillsLoading
            ? "Loading skills."
            : count === 0
              ? "No slash results."
              : `${count} slash result${count === 1 ? "" : "s"}. Commands first, then skills.`,
      );
    }, 180);
    return () => window.clearTimeout(timer);
  }, [commands.length, skills.length, skillsError, skillsLoading]);

  React.useEffect(() => {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const row = (result: SlashResult, available: boolean, unavailableReason?: string) => {
    const selected = result.id === activeId;
    const Icon = result.kind === "command" ? ICONS[result.command.icon] : Sparkles;
    const title = result.kind === "command" ? `/${result.command.name}` : result.skill.name;
    const description =
      result.kind === "command" ? result.command.description : result.skill.description;
    const detail =
      unavailableReason ??
      (result.kind === "skill" ? sourceLabel(result.skill.source) : result.command.title);
    const reasonId = unavailableReason ? `${result.id}-unavailable-reason` : undefined;
    return (
      <div
        id={result.id}
        key={result.id}
        role="option"
        aria-selected={selected}
        aria-disabled={!available || undefined}
        aria-describedby={reasonId}
        data-selected={selected || undefined}
        onPointerMove={() => available && onActiveIdChange(result.id)}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          if (available) onSelect(result);
          else if (unavailableReason) setAnnouncement(unavailableReason);
        }}
        className={cn(
          "flex min-h-12 cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none transition-colors duration-100",
          selected && available && "bg-list-selection",
          !selected && available && "hover:bg-list-hover",
          !available && "opacity-50",
        )}
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-control/65 text-secondary">
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-regular-strong text-primary">{title}</span>
            {result.kind === "command" && result.command.aliases.length > 0 ? (
              <span className="truncate text-mini text-tertiary">
                {result.command.aliases.map((alias) => `/${alias}`).join(" · ")}
              </span>
            ) : null}
          </span>
          <span className="block truncate text-small text-secondary">{description}</span>
        </span>
        <span
          aria-hidden={unavailableReason ? "true" : undefined}
          className="max-w-40 shrink-0 truncate text-right text-mini text-tertiary max-[520px]:hidden"
        >
          {detail}
        </span>
        {unavailableReason ? (
          <span id={reasonId} className="sr-only">
            Unavailable: {unavailableReason}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <div
      className="composer-slash-palette absolute inset-x-3 bottom-full z-40 mb-2 origin-bottom overflow-hidden rounded-popover border border-separator bg-popover/98 shadow-popover backdrop-blur-xl"
      data-composer-slash-palette
      data-presence={presenceState}
      aria-hidden={presenceState === "exiting" ? "true" : undefined}
    >
      <div className="flex h-9 min-w-0 items-center gap-2 border-b border-separator px-3 text-small text-secondary">
        <Search aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">Commands and skills</span>
        <span className="composer-slash-shortcuts ml-auto shrink-0 text-mini text-tertiary max-[520px]:hidden">
          ↑↓ navigate · ↩ run · esc close
        </span>
      </div>
      <div
        id={COMPOSER_SLASH_PALETTE_ID}
        role="listbox"
        aria-label="Slash commands and skills"
        className="max-h-[min(22rem,48vh)] overflow-y-auto overscroll-contain p-1.5 [mask-image:linear-gradient(to_bottom,transparent_0,black_0.35rem,black_calc(100%_-_0.35rem),transparent_100%)]"
      >
        <div role="group" aria-labelledby="slash-command-group-label">
          <div
            id="slash-command-group-label"
            className="sticky top-0 z-10 bg-popover/95 px-2.5 pb-1 pt-1.5 text-mini font-medium uppercase tracking-wide text-tertiary backdrop-blur"
          >
            Commands
          </div>
          {commands.length > 0 ? (
            commands.map((result) => {
              const availability = commandAvailability(result);
              return row(result, availability.available, availability.reason);
            })
          ) : (
            <div role="status" className="min-h-9 px-2.5 py-2 text-small text-secondary">
              No commands match this query.
            </div>
          )}
        </div>

        <div role="group" aria-labelledby="slash-skill-group-label" className="mt-1">
          <div
            id="slash-skill-group-label"
            className="sticky top-0 z-10 bg-popover/95 px-2.5 pb-1 pt-1.5 text-mini font-medium uppercase tracking-wide text-tertiary backdrop-blur"
          >
            Skills
          </div>
          {skillsLoading ? (
            <div className="flex min-h-11 items-center gap-2.5 px-2.5 text-small text-secondary">
              <Sparkles
                aria-hidden="true"
                className="size-4 animate-pulse motion-reduce:animate-none"
              />
              Loading skills…
            </div>
          ) : skillsError ? (
            <div
              id={COMPOSER_SLASH_RETRY_ID}
              role="option"
              aria-label="Retry loading skills"
              aria-selected={activeId === COMPOSER_SLASH_RETRY_ID}
              onPointerMove={() => onActiveIdChange(COMPOSER_SLASH_RETRY_ID)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={onRetrySkills}
              className={cn(
                "flex min-h-11 w-full cursor-default items-center gap-2.5 rounded-lg px-2.5 text-left text-small text-secondary hover:bg-list-hover",
                activeId === COMPOSER_SLASH_RETRY_ID && "bg-list-selection",
              )}
            >
              <Sparkles aria-hidden="true" className="size-4" />
              Skills could not be loaded
              <span className="ml-auto text-mini text-accent">Retry</span>
            </div>
          ) : skills.length > 0 ? (
            skills.map((result) => {
              const available = result.skill.available && skillSelectionEnabled;
              const reason = result.skill.available
                ? skillSelectionEnabled
                  ? undefined
                  : "Selection becomes available with active skill invocation."
                : result.skill.unavailableReason;
              return row(result, available, reason);
            })
          ) : commands.length === 0 ? (
            <div className="flex min-h-11 items-center gap-2.5 px-2.5 text-small text-secondary">
              <Sparkles aria-hidden="true" className="size-4" />
              No commands or skills found.
            </div>
          ) : (
            <div className="flex min-h-11 items-center gap-2.5 px-2.5 text-small text-secondary">
              <Sparkles aria-hidden="true" className="size-4" />
              No skills match this query.
            </div>
          )}
        </div>
      </div>
      {truncated ? (
        <div className="border-t border-separator px-3 py-1.5 text-mini text-tertiary">
          Refine the query to see more results.
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
