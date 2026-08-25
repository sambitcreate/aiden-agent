import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function between(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing ${start}`);
  assert.notEqual(endIndex, -1, `Missing ${end}`);
  return value.slice(startIndex, endIndex);
}

test("sidebar places New Agent above Scheduled beneath search", () => {
  const sidebar = source("./chat-sidebar.tsx");
  const sidebarBody = between(sidebar, "<Sidebar", "</Sidebar>");
  const newAgentIndex = sidebarBody.indexOf("New Agent");
  const scheduledIndex = sidebarBody.indexOf('title="Scheduled"');
  const workspaceIndex = sidebarBody.indexOf("Workspace switcher");

  assert.notEqual(newAgentIndex, -1);
  assert.notEqual(scheduledIndex, -1);
  assert.ok(newAgentIndex < scheduledIndex, "New Agent should appear before Scheduled");
  assert.ok(
    scheduledIndex < workspaceIndex,
    "Scheduled should stay above the workspace switcher and chat list",
  );
});

test("new agent uses the same sidebar row style as scheduled", () => {
  const sidebar = source("./chat-sidebar.tsx");
  const section = between(sidebar, '<div className="flex flex-col gap-0.5 px-2.5 pb-2">', "</div>");
  assert.match(section, /<SidebarListItem[\s\S]*title="New Agent"/u);
  assert.match(section, /<SidebarListItem[\s\S]*title="Scheduled"/u);
  assert.doesNotMatch(section, /variant="accent"/u);
});

test("newAgent creates a chat in the active workspace", () => {
  const sidebar = source("./chat-sidebar.tsx");
  assert.match(sidebar, /const newAgent = React\.useCallback\(async \(\) => \{/u);
  assert.match(sidebar, /if \(!activeId \|\| appendReconciliationRequired\) return;/u);
  assert.match(sidebar, /chatsApi\.create\(\{ workspaceId: activeId \}\)/u);
  assert.match(
    sidebar,
    /navigate\(\{ to: "\/chat\/\$chatId", params: \{ chatId: created\.id \} \}\)/u,
  );
});

test("downloaded updates appear immediately above Profile in the sidebar footer", () => {
  const sidebar = source("./chat-sidebar.tsx");
  const footer = between(sidebar, "footer={", "\n        }");
  const updateIndex = footer.indexOf("<UpdateReadyBanner");
  const profileIndex = footer.indexOf('title="Profile"');
  const settingsIndex = footer.indexOf('title="Settings"');

  assert.notEqual(updateIndex, -1);
  assert.ok(updateIndex < profileIndex, "the temporary update status should lead the footer");
  assert.ok(profileIndex < settingsIndex, "Profile and Settings should keep their stable order");
});

test("sidebar keeps a compact mobile connection surface beside Settings", () => {
  const sidebar = source("./chat-sidebar.tsx");
  const connectionPopover = source("./remote-connection-popover.tsx");

  assert.match(sidebar, /<RemoteConnectionPopover/u);
  assert.match(sidebar, /search: \{ section: "remoteAccess" \}/u);
  assert.match(connectionPopover, /aria-label=\{`Mobile connections · \$\{summary\}`\}/u);
  assert.match(connectionPopover, /label="Active"/u);
  assert.match(connectionPopover, /label="Inactive"/u);
  assert.match(connectionPopover, />Previous</u);
  assert.match(connectionPopover, /Add or manage connections/u);
});

test("update banner reports progress, failure recovery, and a guarded restart action", () => {
  const sidebar = source("./chat-sidebar.tsx");
  const banner = between(
    sidebar,
    "function UpdateReadyBanner",
    "\n}\n\nfunction GeneratedTitleReveal",
  );

  assert.match(banner, /Update ready/u);
  assert.match(banner, /Downloading update/u);
  assert.match(banner, /Update download failed/u);
  assert.match(banner, /Aiden Agent \{displayedVersion\}/u);
  assert.match(banner, /Restart to finish installing\./u);
  assert.match(banner, /"Later"/u);
  assert.match(banner, /Try again/u);
  assert.match(banner, /appUpdatesApi\.check\(\)/u);
  assert.match(banner, /Update and restart/u);
  assert.match(banner, /appUpdatesApi\.restart\(\)/u);
  assert.match(banner, /disabled=\{!open \|\| restarting \|\| Boolean\(blockedReason\)\}/u);
  assert.match(banner, /role="progressbar"/u);
});

test("a stale initial update-state response cannot overwrite a newer notification", () => {
  const hook = source("../lib/use-app-update-snapshot.ts");

  assert.match(hook, /let notificationRevision = 0;/u);
  assert.match(hook, /notificationRevision \+= 1;\s+applySnapshot\(next\);/u);
  assert.match(hook, /const requestedAtRevision = notificationRevision;/u);
  assert.match(hook, /if \(notificationRevision === requestedAtRevision\) applySnapshot\(next\);/u);
});

test("About exposes the observable updater lifecycle and retry in the initiating surface", () => {
  const about = source("./settings/about-settings.tsx");

  assert.match(about, /label="Software update"/u);
  assert.match(about, /useAppUpdateSnapshot\(\)/u);
  assert.match(about, /appUpdatesApi\.check\(\)/u);
  assert.match(about, /appUpdatesApi\.restart\(\)/u);
  assert.match(about, /Check for updates/u);
  assert.match(about, /Downloading…/u);
  assert.match(about, /Try again/u);
  assert.match(about, /Update and restart/u);
  assert.match(about, /role="progressbar"/u);
});

test("update-ready banner uses the Aiden mark and shared compact-surface motion", () => {
  const sidebar = source("./chat-sidebar.tsx");
  const styles = source("../styles.css");
  const banner = between(
    sidebar,
    "function UpdateReadyBanner",
    "\n}\n\nfunction GeneratedTitleReveal",
  );

  assert.match(sidebar, /const AIDEN_MARK_URL = new URL\("\.\.\/\.\.\/resources\/app-icon\.png"/u);
  assert.match(banner, /<img src=\{AIDEN_MARK_URL\} alt="" className="size-8 shrink-0" \/>/u);
  assert.doesNotMatch(sidebar, /CircleArrowUp/u);
  assert.match(banner, /data-state=\{open \? "open" : "closed"\}/u);
  assert.match(banner, /setTimeout\(\(\) => setPresent\(false\), APP_UPDATE_BANNER_EXIT_MS\)/u);
  assert.match(
    styles,
    /@keyframes aiden-app-update-banner-in[\s\S]*translateY\(4px\) scale\(0\.98\)/u,
  );
  assert.match(
    styles,
    /:root\[data-reduce-motion="false"\] \.app-update-banner\[data-state="open"\][\s\S]*150ms cubic-bezier\(0\.19, 1, 0\.22, 1\)/u,
  );
  assert.match(
    styles,
    /:root\[data-reduce-motion="false"\] \.app-update-banner\[data-state="closed"\][\s\S]*120ms ease-in/u,
  );
});

test("chat pane toolbar no longer exposes a duplicate new-chat control", () => {
  const pane = source("../main/chat-pane.tsx");
  assert.doesNotMatch(pane, /SquarePen/u);
  assert.doesNotMatch(pane, /aria-label="New chat"/u);
  assert.doesNotMatch(pane, /\bnewChat\b/u);
});

test("workspace menu middle-truncates folder paths", () => {
  const sidebar = source("./chat-sidebar.tsx");
  assert.match(sidebar, /import \{ truncatePathMiddle \} from "\.\.\/lib\/truncate-path"/u);
  assert.match(
    sidebar,
    /sublabel=\{\s*w\.folderPath \? truncatePathMiddle\(w\.folderPath\) : undefined\s*\}/u,
  );
  assert.match(sidebar, /title=\{w\.folderPath \?\? undefined\}/u);
});

test("successful chat deletion removes the exact transcript cache before list refresh", () => {
  const sidebar = source("./chat-sidebar.tsx");
  const deletion = between(sidebar, "const commitDelete = async () => {", "\n  };");
  const remove = deletion.indexOf("await chatsApi.remove(deleting.id)");
  const purge = deletion.indexOf("await removeDeletedChatFromCache(qc, deleting.id)");
  const refresh = deletion.indexOf("await qc.invalidateQueries({ queryKey: queryKeys.chats })");

  assert.ok(remove >= 0);
  assert.ok(purge > remove);
  assert.ok(refresh > purge);
});

test("managed worktrees expose only the recovery-aware delete action", () => {
  const sidebar = source("./chat-sidebar.tsx");
  assert.match(
    sidebar,
    /active\.managedWorktree[\s\S]+Delete worktree…[\s\S]+!active\.managedWorktree[\s\S]+Remove “\{active\.name\}”/u,
  );
});

test("settings reuses the chat sidebar width so the chrome does not jump", () => {
  const settings = source("../main/settings-view.tsx");
  const chat = source("../main/chat-layout.tsx");
  assert.match(chat, /storageKey="aiden-agent"/u);
  assert.match(chat, /sidebarSize=\{\{ default: 272, min: 236, max: 340 \}\}/u);
  assert.match(settings, /storageKey="aiden-agent"/u);
  assert.match(settings, /sidebarSize=\{\{ default: 272, min: 236, max: 340 \}\}/u);
  assert.doesNotMatch(settings, /aiden-agent-settings/u);
});

test("Aiden settings uses the canonical sidebar logo", () => {
  const settings = source("../main/settings-view.tsx");
  const rendererLogo = readFileSync(
    new URL("../../resources/aiden-sidebar-logo.png", import.meta.url),
  );
  const canonicalLogo = readFileSync(
    new URL(
      "../../ios/AidenOnTheGo/Resources/Assets.xcassets/AidenSidebarLogo.imageset/aiden-sidebar-logo.png",
      import.meta.url,
    ),
  );

  assert.match(settings, /assistant: <AidenSidebarLogo\s*\/>/u);
  assert.match(settings, /resources\/aiden-sidebar-logo\.png/u);
  assert.doesNotMatch(settings, /assistant: <Sparkles/u);
  assert.deepEqual(rendererLogo, canonicalLogo);
});

test("sidebar collapse keeps shared chrome geometry on one synchronized motion curve", () => {
  const ui = source("./ui.tsx");
  assert.match(
    ui,
    /bg-sidebar transition-\[width,opacity\] duration-300 ease-out motion-reduce:transition-none/u,
  );
  assert.match(
    ui,
    /scroll-area-header[\s\S]{0,180}transition-\[padding\] duration-300 ease-out motion-reduce:transition-none/u,
  );
  assert.match(ui, /style=\{\{ paddingLeft: split\?\.collapsed \? 142 : undefined \}\}/u);
});

test("sidebar breakpoint hands layout width through an animated spacer", () => {
  const ui = source("./ui.tsx");
  assert.match(ui, /const reservedSidebarWidth = !compact && !collapsed \? width : 0;/u);
  assert.match(ui, /absolute inset-y-0 left-0 z-10[\s\S]{0,120}transition-\[width,opacity\]/u);
  assert.match(
    ui,
    /aria-hidden="true"[\s\S]{0,180}transition-\[width\] duration-300 ease-out motion-reduce:transition-none[\s\S]{0,120}reservedSidebarWidth/u,
  );
  assert.doesNotMatch(ui, /compact && !collapsed && "absolute inset-y-0/u);
});

test("compact split view starts collapsed before first paint", () => {
  const ui = source("./ui.tsx");
  assert.match(
    ui,
    /useState\(\s*\(\) => window\.innerWidth < 700 \|\| localStorage\.getItem\(collapseKey\) === "1"/u,
  );
});

test("allocated composer and settings widths drive their compact layouts", () => {
  const composer = source("./composer.tsx");
  const settings = source("../main/settings-view.tsx");
  const styles = source("../styles.css");
  assert.match(composer, /className="composer-responsive pointer-events-auto relative isolate"/u);
  assert.match(settings, /className="settings-responsive mx-auto w-full max-w-2xl/u);
  assert.match(styles, /\.composer-responsive\s*\{\s*container: composer \/ inline-size;/u);
  assert.match(styles, /@container composer \(max-width: 520px\)/u);
  assert.match(styles, /\.settings-responsive\s*\{\s*container: settings-content \/ inline-size;/u);
  assert.match(styles, /@container settings-content \(max-width: 640px\)/u);
});

test("environment inline handoff uses the same animated spacer pattern", () => {
  const panel = source("./environment-panel.tsx");
  assert.match(panel, /environment-panel absolute inset-y-0 right-0 z-30/u);
  assert.match(
    panel,
    /transition-\[width\] duration-300 ease-out motion-reduce:transition-none[\s\S]{0,180}fullOpen && inline \? renderedWidth : 0/u,
  );
  assert.doesNotMatch(panel, /inline \? "relative" : "absolute/u);
});

test("terminal drawer keeps its exit surface until the shared motion completes", () => {
  const terminal = source("./terminal-drawer.tsx");
  const styles = source("../styles.css");
  assert.match(terminal, /const TERMINAL_DRAWER_MOTION_MS = 300;/u);
  assert.match(terminal, /data-state=\{open \? "open" : "closed"\}/u);
  assert.match(terminal, /reduceMotion \? 0 : TERMINAL_DRAWER_MOTION_MS/u);
  assert.match(styles, /\.terminal-drawer\[data-state="closed"\][\s\S]*height: 0;/u);
  assert.match(styles, /:root\[data-reduce-motion="true"\] \.terminal-drawer/u);
});

test("sidebar list items use a fill focus state instead of a focus ring", () => {
  const ui = source("./ui.tsx");
  const item = between(ui, "export function SidebarListItem", "\n\nexport function ScrollArea");
  assert.match(item, /focus-visible:bg-list-selection/u);
  assert.doesNotMatch(item, /focus-visible:ring/u);
});

test("shared controls use theme fill or border focus instead of focus rings", () => {
  const ui = source("./ui.tsx");
  const button = between(ui, "export const Button =", "});");
  const input = between(ui, "export const Input =", "});");
  assert.match(button, /focus-visible:bg-list-selection/u);
  assert.match(button, /focus-visible:bg-control-active/u);
  assert.match(button, /focus-visible:bg-accent-hover/u);
  assert.doesNotMatch(button, /focus-visible:ring/u);
  assert.match(input, /focus:border-focus-ring/u);
  assert.match(input, /focus:bg-input/u);
  assert.doesNotMatch(input, /focus:ring-/u);
  assert.doesNotMatch(ui, /focus-visible:ring-focus-ring/u);
  assert.doesNotMatch(ui, /focus:ring-focus-ring/u);
});

test("toasts use elevation without a colored border or outline", () => {
  const styles = source("../styles.css");
  assert.match(styles, /--elevation-toast: 0 4px 12px/u);
  for (const token of ["normal", "success", "error", "info", "warning"]) {
    assert.match(styles, new RegExp(`--${token}-border: transparent !important;`, "u"));
  }
  assert.match(
    styles,
    /\[data-sonner-toast\] \{\s*border: 0 !important;[\s\S]*outline: 0 !important;/u,
  );
  assert.doesNotMatch(styles, /--elevation-toast: 0 0 0/u);
});

test("working chats receive an accessible animated sidebar indicator", () => {
  const sidebar = source("./chat-sidebar.tsx");
  const styles = source("../styles.css");
  const indicator = between(sidebar, "function ChatActivityIndicator", "\n}\n\nconst MONTHS");

  assert.match(sidebar, /useActiveChatIds\(\)/u);
  assert.match(
    sidebar,
    /activeChatIds\.has\(chat\.id\)[\s\S]{0,140}chat\.id === activeChatId && environmentPanel\.agentBusy/u,
  );
  assert.match(sidebar, /aria-busy=\{renamingWithAppleId === chat\.id \|\| working\}/u);
  assert.match(indicator, /aria-label="Working"/u);
  assert.match(
    indicator,
    /<Loader2 className="size-4 animate-\[spin_1\.5s_linear_infinite\]" aria-hidden="true" \/>/u,
  );
  assert.match(
    styles,
    /:root\[data-reduce-motion="true"\] \*[\s\S]*animation-duration: 0\.001ms !important;[\s\S]*animation-iteration-count: 1 !important;/u,
  );
});
