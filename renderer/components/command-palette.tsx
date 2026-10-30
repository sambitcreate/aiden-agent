import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  CircleAlert,
  Folder,
  FolderDown,
  FolderPlus,
  Keyboard,
  MessageCircle,
  MessageSquare,
  Moon,
  Palette,
  RefreshCw,
  Search,
  Server,
  Settings,
  Sun,
  Wrench,
} from "lucide-react";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList, toast } from "./ui";
import { cn } from "../lib/ui-utils";
import { paletteCommands } from "../lib/command-system-core";
import {
  ariaKeyShortcut,
  prettyAccelerator,
  type CommandCategory,
  type CommandId,
} from "../shared/keybindings";
import {
  useCommandHandler,
  useCommandSystem,
  type CommandPaletteMode,
} from "../lib/command-system";
import {
  useAllRegularChats,
  useChats,
  useProviders,
  useSettings,
  queryKeys,
} from "../lib/queries";
import { useActiveWorkspace } from "../lib/workspace-context";
import { useNewChatActions } from "../lib/new-chat-actions";
import { newChatWorkspaceChoices } from "../lib/new-chat-workspaces";
import { NO_WORKSPACE_LABEL, isNoWorkspace, noWorkspaceHome } from "../lib/no-workspace";
import { useOpenWorkspacePathRow, useWorkspacePathIntake } from "../lib/use-workspace-path-intake";
import type { WorkspacePathRow } from "../lib/workspace-menu";
import { formatWorkspacePath, workspaceDisplayName } from "../lib/workspace-path-display";
import { useWorkspacePathPreferences } from "../lib/use-workspace-path-preferences";
import { botsApi, providersApi, settingsApi } from "../lib/ipc";
import { botChatPath } from "../lib/bot-routes";
import {
  readActiveChatModelTarget,
  readModelSelectionRevision,
  useActiveChatModelTarget,
  useModelSelection,
} from "../lib/use-model-selection";
import { createModelEntries, isUsable, visibleModelEntries } from "../lib/model-picker-data";
import { availableSettingsDestinations } from "../lib/settings-section";
import { useAppCapabilities } from "../lib/app-capabilities";
import {
  createDefaultAppearanceConfig,
  normalizeAppearanceConfig,
  type AppearanceMode,
} from "../shared/appearance";
import {
  announceAppearanceIntentFailure,
  applyAppearanceConfig,
  beginAppearanceIntent,
  readCachedAppearance,
  runAppearanceIntent,
} from "../lib/appearance-runtime";
import {
  COMMAND_PALETTE_RECENT_KEY,
  normalizeRecentCommands,
  persistRecentCommands,
  recordRecentCommand,
} from "../lib/command-palette-recent";
import {
  filterPaletteResult,
  paletteResult,
  reconcilePaletteResult,
  staticPaletteResult,
  type PaletteResult,
} from "../lib/command-palette-results";

const MODE_LABELS: Record<CommandPaletteMode, string> = {
  root: "Commands",
  chats: "Chats",
  bots: "Bots",
  newChatIn: "New chat in",
  models: "Models",
  providers: "Providers",
  settings: "Settings",
};

const CATEGORY_ICON: Record<CommandCategory, React.ComponentType<{ className?: string }>> = {
  Aiden: Bot,
  Chat: MessageSquare,
  Navigate: Search,
  Tools: Wrench,
  Settings,
};

function Shortcut({ commandId }: { commandId: CommandId }) {
  const { binding } = useCommandSystem();
  const value = binding(commandId);
  if (!value) return null;
  return (
    <kbd className="ml-auto shrink-0 rounded-md bg-control/55 px-1.5 py-0.5 font-sans text-mini text-secondary">
      {prettyAccelerator(value)}
    </kbd>
  );
}

function ItemDetail({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto min-w-0 truncate text-small text-tertiary">{children}</span>;
}

function PaletteResultItem({
  result,
  ...props
}: Omit<React.ComponentProps<typeof CommandItem>, "value" | "keywords" | "disabled" | "forceMount"> & {
  result: PaletteResult;
}) {
  return (
    <CommandItem
      {...props}
      value={result.value}
      keywords={result.keywords}
      disabled={result.disabled}
      forceMount={result.forceMount}
    />
  );
}

export function AppCommandPalette({
  navigationBlockedReason,
}: {
  navigationBlockedReason: string | null;
}) {
  const capabilities = useAppCapabilities();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeId, workspaces } = useActiveWorkspace();
  const { binding, canExecute, execute, palette } = useCommandSystem();
  const chats = useChats(activeId);
  const newChat = useNewChatActions();
  const pathPreferences = useWorkspacePathPreferences();
  const choosingWorkspace = palette.open && palette.mode === "newChatIn";
  const allChats = useAllRegularChats(choosingWorkspace && workspaces.length > 0);
  const providers = useProviders();
  const settings = useSettings();
  const selection = useModelSelection(
    providers.data,
    settings.data?.hiddenModelsByProvider,
    settings.data !== undefined,
  );
  // In an open chat with messages, a model change applies to that chat only.
  const chatModelTarget = useActiveChatModelTarget();
  const currentModel = chatModelTarget?.selection ?? selection;
  const [query, setQuery] = React.useState("");
  const [activeResult, setActiveResult] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const modelSelectionEpoch = React.useRef(0);
  const [recentCommands, setRecentCommands] = React.useState<CommandId[]>(() => {
    try {
      return normalizeRecentCommands(
        JSON.parse(localStorage.getItem(COMMAND_PALETTE_RECENT_KEY) ?? "[]"),
      );
    } catch {
      return [];
    }
  });
  const models = React.useMemo(
    () =>
      settings.data
        ? visibleModelEntries(
            createModelEntries(providers.data ?? []),
            settings.data?.hiddenModelsByProvider,
          )
        : [],
    [providers.data, settings.data],
  );
  const unavailableModelProviders = React.useMemo(
    () => (providers.data ?? []).filter((provider) => !isUsable(provider)),
    [providers.data],
  );
  // Not memoized: which commands something on screen handles changes as views mount.
  const recentOrder = new Map(recentCommands.map((id, index) => [id, index]));
  const rootCommands = paletteCommands(capabilities, canExecute).sort(
    (left, right) =>
      (recentOrder.get(left.id) ?? Number.POSITIVE_INFINITY) -
      (recentOrder.get(right.id) ?? Number.POSITIVE_INFINITY),
  );
  const bots = useQuery({
    queryKey: [...queryKeys.bots, "active"],
    queryFn: () => botsApi.list(false),
    enabled: capabilities.bots && palette.open && palette.mode === "bots",
  });
  const botResults = React.useMemo(
    () => (bots.data ?? []).map((bot) => ({
      bot,
      result: paletteResult(`bot:${bot.id}`, [bot.name, bot.description ?? ""]),
    })),
    [bots.data],
  );
  const chatResults = React.useMemo(
    () => [...(chats.data ?? [])]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((chat) => ({
        chat,
        result: paletteResult(`chat:${chat.id}`, [
          chat.title,
          new Date(chat.updatedAt).toLocaleString(),
        ]),
      })),
    [chats.data],
  );
  const modelResults = React.useMemo(
    () => models.map((entry) => ({
      entry,
      result: {
        ...paletteResult(`model:${entry.value}`, [entry.label, entry.model, entry.providerLabel]),
        disabled: busy,
      },
    })),
    [models, busy],
  );
  const unavailableResults = React.useMemo(
    () => unavailableModelProviders.map((provider) => ({
      provider,
      result: paletteResult(`unavailable-provider:${provider.id}`, [
        provider.label, ...provider.models, "unavailable setup provider",
      ]),
    })),
    [unavailableModelProviders],
  );
  const providerResults = React.useMemo(
    () => (providers.data ?? []).map((provider) => ({
      provider,
      result: paletteResult(`provider:${provider.id}`, [
        provider.label, provider.id, "manage connection models",
      ]),
    })),
    [providers.data],
  );
  const rootResults = rootCommands.map((definition) => ({
    definition,
    result: staticPaletteResult(
      `${definition.title} ${definition.description} ${definition.keywords.join(" ")}`,
      { disabled: !canExecute(definition.id) },
    ),
  }));
  const newChatResult = staticPaletteResult("New chat conversation", {
    disabled: !canExecute("chat.new"),
  });
  const workspaceResults = React.useMemo(
    () =>
      newChatWorkspaceChoices(workspaces, allChats.data ?? [], activeId).map((choice) => ({
        ...choice,
        name: workspaceDisplayName(choice.workspace, workspaces),
        result: paletteResult(`new-chat-in:${choice.workspace.id}`, [
          choice.workspace.name,
          choice.workspace.folderPath ?? "",
        ]),
      })),
    [activeId, allChats.data, workspaces],
  );
  const noWorkspaceHomeId = noWorkspaceHome(workspaces)?.id;
  const noWorkspaceCurrent = isNoWorkspace(workspaces.find((workspace) => workspace.id === activeId));
  const noWorkspaceResult = staticPaletteResult("No workspace just chat global settings");
  const openFolderResult = staticPaletteResult("Open folder… add workspace directory");
  const cloneResult = staticPaletteResult("Clone repository… git url github");
  // A typed path (`/`, `~`, `.`) is answered by one row: select, open or create.
  const pathIntake = useWorkspacePathIntake(query, {
    enabled: choosingWorkspace,
    relativeToWorkspaceId: activeId,
    workspaces,
  });
  const openPathRow = useOpenWorkspacePathRow(activeId);
  const pathRow = pathIntake.row;
  const pathRowResult =
    pathRow && pathRow.action !== "invalid"
      ? paletteResult(`path:${pathRow.action}:${pathRow.input}`, [query])
      : null;
  const chatRetryResult = staticPaletteResult("Retry loading chats", { forceMount: true });
  const modelRetryResult = staticPaletteResult("Retry loading models", { forceMount: true });
  const providerRetryResult = staticPaletteResult("Retry loading providers", { forceMount: true });
  const refreshResult = staticPaletteResult("Refresh provider model catalogs update", {
    disabled: busy,
  });
  const appearanceResults = [
    { mode: "system" as const, title: "Follow system appearance", icon: Palette },
    { mode: "light" as const, title: "Use light appearance", icon: Sun },
    { mode: "dark" as const, title: "Use dark appearance", icon: Moon },
  ].map((item) => ({
    ...item,
    result: staticPaletteResult(`${item.title} theme appearance`, { disabled: busy }),
  }));
  const settingsResults = availableSettingsDestinations(capabilities).map((destination) => ({
    destination,
    result: staticPaletteResult(`${destination.title} ${destination.keywords.join(" ")}`),
  }));
  // One inventory owns both rendering and selection, including static actions,
  // disabled states and force-mounted retry rows in every palette mode.
  // Appearance rows also answer a typed search at the top level ("dark").
  const rootAppearance = query.trim() ? appearanceResults : [];
  const resultsByMode: Record<CommandPaletteMode, PaletteResult[]> = {
    root: [...rootResults.map(({ result }) => result), ...rootAppearance.map(({ result }) => result)],
    bots: botResults.map(({ result }) => result),
    chats: [
      newChatResult,
      ...(chats.isError ? [chatRetryResult] : []),
      ...chatResults.map(({ result }) => result),
    ],
    newChatIn: pathIntake.pathQuery
      ? pathRowResult ? [pathRowResult] : []
      : [
          ...workspaceResults.map(({ result }) => result),
          ...(noWorkspaceHomeId ? [noWorkspaceResult] : []),
          openFolderResult,
          cloneResult,
        ],
    models: providers.isLoading ? [] : providers.isError ? [modelRetryResult]
      : [...modelResults, ...unavailableResults].map(({ result }) => result),
    providers: [
      refreshResult,
      ...(providers.isError ? [providerRetryResult] : []),
      ...providerResults.map(({ result }) => result),
    ],
    settings: [...appearanceResults, ...settingsResults].map(({ result }) => result),
  };
  const currentResults = resultsByMode[palette.mode];
  const selectedResultValue = reconcilePaletteResult(activeResult, currentResults, query);
  React.useLayoutEffect(() => {
    // Persist a fallback too, so a removed result cannot reclaim selection if it
    // later reappears. Do not overwrite a newer keyboard/pointer selection.
    if (selectedResultValue !== activeResult) {
      setActiveResult((current) => current === activeResult ? selectedResultValue : current);
    }
  }, [activeResult, selectedResultValue]);
  const appearanceMode = normalizeAppearanceConfig(
    settings.data?.appearance ?? createDefaultAppearanceConfig(),
  ).mode;

  useCommandHandler("chat.search", () => palette.openMode("chats"));
  useCommandHandler("model.change", () => palette.openMode("models"));
  useCommandHandler("provider.manage", () => palette.openMode("providers"));
  useCommandHandler("settings.search", () => palette.openMode("settings"));
  useCommandHandler("bots.search", () => palette.openMode("bots"), capabilities.bots);

  React.useEffect(() => {
    if (palette.open) setQuery("");
  }, [palette.mode, palette.open]);

  const close = React.useCallback(() => palette.setOpen(false), [palette]);
  const rememberCommand = React.useCallback((commandId: CommandId) => {
    setRecentCommands((current) => {
      const next = recordRecentCommand(current, commandId);
      persistRecentCommands(localStorage, next);
      return next;
    });
  }, []);
  const allowNavigation = React.useCallback(() => {
    if (!navigationBlockedReason) return true;
    toast.info(navigationBlockedReason);
    return false;
  }, [navigationBlockedReason]);
  const enterMode = React.useCallback(
    (mode: CommandPaletteMode) => {
      setQuery("");
      palette.openMode(mode);
    },
    [palette],
  );
  const runCommand = React.useCallback(
    (commandId: CommandId) => {
      rememberCommand(commandId);
      if (commandId === "chat.search") return enterMode("chats");
      if (commandId === "chat.newIn") return enterMode("newChatIn");
      if (commandId === "model.change") return enterMode("models");
      if (commandId === "provider.manage") return enterMode("providers");
      if (commandId === "settings.search") return enterMode("settings");
      if (commandId === "bots.search") return enterMode("bots");
      close();
      requestAnimationFrame(() => execute(commandId));
    },
    [close, enterMode, execute, rememberCommand],
  );

  const openChat = async (chatId: string) => {
    if (!allowNavigation()) return;
    rememberCommand("chat.search");
    close();
    await navigate({ to: "/chat/$chatId", params: { chatId } });
  };

  // ⌥↵ on a New chat in… row opens the draft with New worktree selected.
  const newWorktreeKeyRef = React.useRef(false);
  const startChatIn = (workspaceId: string) => {
    const newWorktree = newWorktreeKeyRef.current;
    newWorktreeKeyRef.current = false;
    if (!allowNavigation()) return;
    rememberCommand("chat.newIn");
    close();
    void newChat.openNewChatIn(workspaceId, newWorktree ? { newWorktree } : undefined).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Aiden could not start a chat there.");
    });
  };

  const openFolderForChat = () => {
    if (!allowNavigation()) return;
    rememberCommand("chat.newIn");
    close();
    void newChat.openFolderForNewChat().catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Aiden could not open that folder.");
    });
  };

  const cloneForChat = () => {
    if (!allowNavigation()) return;
    rememberCommand("chat.newIn");
    close();
    void newChat.cloneRepositoryForNewChat().catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Aiden could not start a chat there.");
    });
  };

  const choosePathRow = (row: WorkspacePathRow) => {
    if (row.action === "invalid") return;
    if (row.action === "select") {
      startChatIn(row.workspaceId);
      return;
    }
    if (!allowNavigation()) return;
    rememberCommand("chat.newIn");
    close();
    void openPathRow(row)
      .then((workspace) => newChat.openNewChatIn(workspace.id))
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Aiden could not open that folder.");
      });
  };

  const selectModel = async (providerId: string, model: string) => {
    const epoch = ++modelSelectionEpoch.current;
    const selectionRevision = readModelSelectionRevision();
    const targetChatId = readActiveChatModelTarget()?.chatId;
    // This action belongs to the palette session where the click happened.
    // Close that session synchronously so a delayed provider revalidation
    // cannot close a newer session the user opens while this work is pending.
    close();
    setBusy(true);
    try {
      const latest = await providersApi.list();
      if (
        epoch !== modelSelectionEpoch.current ||
        selectionRevision !== readModelSelectionRevision()
      )
        return;
      queryClient.setQueryData(queryKeys.providers, latest);
      const provider = latest.find((candidate) => candidate.id === providerId);
      if (!provider || !isUsable(provider) || !provider.models.includes(model)) {
        toast.error("That model is no longer available. The model list has been refreshed.");
        return;
      }
      if (targetChatId) {
        // The pick belongs to the chat that was open; drop it if that chat closed.
        const target = readActiveChatModelTarget();
        if (target?.chatId !== targetChatId) return;
        target.select(providerId, model);
      } else {
        selection.select(providerId, model);
      }
      rememberCommand("model.change");
      toast.success(`Model changed to ${model}`);
    } catch (error) {
      if (epoch !== modelSelectionEpoch.current) return;
      toast.error(error instanceof Error ? error.message : "The model could not be selected.");
    } finally {
      if (epoch === modelSelectionEpoch.current) setBusy(false);
    }
  };

  const refreshProviders = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await providersApi.refresh();
      queryClient.setQueryData(queryKeys.providers, result.providers);
      if (result.errors.length > 0) {
        toast.warning(
          `${result.providers.length > 0 ? "Available catalogs refreshed; " : ""}${result.errors.length} provider catalog${result.errors.length === 1 ? "" : "s"} kept cached models.`,
        );
      } else {
        toast.success("Provider model catalogs refreshed");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Providers could not be refreshed.");
    } finally {
      setBusy(false);
    }
  };

  const setAppearance = async (mode: AppearanceMode) => {
    if (busy) return;
    const revision = beginAppearanceIntent();
    // Persist in the background after dismissing the originating session.
    // Never close later: the user may have reopened Command-K meanwhile.
    close();
    setBusy(true);
    try {
      await runAppearanceIntent(revision, async (isCurrent) => {
        let previousAppearance: ReturnType<typeof normalizeAppearanceConfig> | null = null;
        let persisted = false;
        try {
          const currentSettings = await settingsApi.get();
          if (!isCurrent()) return;
          previousAppearance = normalizeAppearanceConfig(
            readCachedAppearance() ?? currentSettings.appearance ?? createDefaultAppearanceConfig(),
          );
          const appearance = {
            ...previousAppearance,
            mode,
          };
          await settingsApi.previewAppearance(appearance);
          if (!isCurrent()) return;
          await settingsApi.set({ appearance });
          persisted = true;
          if (!isCurrent()) return;
          await window.aidenAPI.nativeTheme.setThemeSource(mode);
          if (!isCurrent()) {
            const latest = readCachedAppearance();
            if (latest) {
              await window.aidenAPI.nativeTheme.setThemeSource(latest.mode);
            }
            return;
          }
          const native = await window.aidenAPI.nativeTheme.getInfo();
          if (!isCurrent()) return;
          applyAppearanceConfig(
            appearance,
            native.shouldUseDarkColors,
            native.shouldUseHighContrastColors === true,
          );
          await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
          if (!isCurrent()) return;
          toast.success(
            mode === "system"
              ? "Appearance now follows the system"
              : `${mode === "dark" ? "Dark" : "Light"} appearance enabled`,
          );
        } catch (error) {
          if (!isCurrent()) return;
          let rollbackError: unknown = null;
          if (!persisted && previousAppearance) {
            try {
              await settingsApi.previewAppearance(previousAppearance);
            } catch (reason) {
              rollbackError = reason;
            }
          } else if (persisted && previousAppearance) {
            try {
              await settingsApi.set({ appearance: previousAppearance });
              if (!isCurrent()) return;
              await window.aidenAPI.nativeTheme.setThemeSource(previousAppearance.mode);
              if (!isCurrent()) return;
              const native = await window.aidenAPI.nativeTheme.getInfo();
              if (!isCurrent()) return;
              applyAppearanceConfig(
                previousAppearance,
                native.shouldUseDarkColors,
                native.shouldUseHighContrastColors === true,
              );
              await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
              if (!isCurrent()) return;
            } catch (reason) {
              rollbackError = reason;
            }
          }
          if (!isCurrent()) return;
          const message =
            error instanceof Error ? error.message : "Appearance could not be changed.";
          toast.error(
            rollbackError
              ? `${message} The previous appearance could not be restored; reopen Appearance settings.`
              : message,
          );
          announceAppearanceIntentFailure(revision);
        }
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogPrimitive.Root open={palette.open} onOpenChange={palette.setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="dialog-overlay"
          className="fixed inset-0 z-50 bg-transparent"
        />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          data-command-palette-content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[16vh] z-50 w-[min(92vw,640px)] -translate-x-1/2 overflow-hidden rounded-dialog bg-popover shadow-modal outline-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() =>
              document.querySelector<HTMLInputElement>("[data-command-palette-input]")?.focus(),
            );
          }}
          onEscapeKeyDown={(event) => {
            if (palette.mode === "root") return;
            event.preventDefault();
            enterMode("root");
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {MODE_LABELS[palette.mode]}
          </DialogPrimitive.Title>
          <Command
            value={selectedResultValue}
            onValueChange={setActiveResult}
            className="min-h-[420px] [&_[cmdk-item][data-selected=true]]:bg-control"
            // Dynamic values identify rows; search only their human-readable metadata.
            filter={filterPaletteResult}
          >
            <div className="flex h-10 items-center px-3">
              {palette.mode === "root" ? (
                <span className="mr-2 flex size-6 items-center justify-center rounded-md bg-control text-secondary">
                  <Keyboard className="size-3.5" />
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => enterMode("root")}
                  className="mr-1 flex size-7 items-center justify-center rounded-full text-secondary outline-none hover:bg-list-hover focus-visible:bg-list-selection"
                  aria-label="Back to commands"
                >
                  <ArrowLeft className="size-4" />
                </button>
              )}
              <span className="text-small-strong text-secondary">{MODE_LABELS[palette.mode]}</span>
              <span className="mx-2 text-tertiary">/</span>
              <span className="truncate text-small text-tertiary">
                {activeId ? "Active workspace" : "Aiden"}
              </span>
              <kbd className="ml-auto rounded-md bg-control px-1.5 py-0.5 font-sans text-mini text-tertiary">
                Esc
              </kbd>
            </div>
            <CommandInput
              data-command-palette-input
              containerClassName="px-4"
              showSeparator={false}
              value={query}
              onValueChange={setQuery}
              placeholder={
                palette.mode === "root"
                  ? "Search commands, chats, models, providers, or settings…"
                  : palette.mode === "newChatIn"
                    ? "Search workspaces or paste a path…"
                    : `Search ${MODE_LABELS[palette.mode].toLocaleLowerCase()}…`
              }
              aria-label={
                palette.mode === "newChatIn"
                  ? "Search workspaces"
                  : `Search ${MODE_LABELS[palette.mode].toLocaleLowerCase()}`
              }
              className="h-11"
              onKeyDown={(event) => {
                // Read by the row cmdk selects for this Enter, right after this handler.
                newWorktreeKeyRef.current =
                  palette.mode === "newChatIn" && event.key === "Enter" && event.altKey;
                if (
                  palette.mode !== "root" &&
                  query.length === 0 &&
                  (event.key === "Backspace" || event.key === "ArrowLeft")
                ) {
                  event.preventDefault();
                  enterMode("root");
                }
              }}
            />
            <CommandList className="h-[320px] max-h-[min(320px,calc(100vh-12rem))] p-2">
              {palette.mode === "newChatIn" && pathIntake.pathQuery ? null : <CommandEmpty>
                <Search className="mx-auto mb-2 size-5 text-tertiary" />
                No{" "}
                {palette.mode === "newChatIn"
                  ? "workspaces"
                  : MODE_LABELS[palette.mode].toLocaleLowerCase()}{" "}
                match “{query.trim()}”.
              </CommandEmpty>}

              {palette.mode === "root"
                ? rootResults.map(({ definition, result }) => {
                    const Icon = CATEGORY_ICON[definition.category];
                    const opensMode = [
                      "bots.search",
                      "chat.search",
                      "chat.newIn",
                      "model.change",
                      "provider.manage",
                      "settings.search",
                    ].includes(definition.id);
                    return (
                      <PaletteResultItem
                        key={definition.id}
                        result={result}
                        onSelect={() => runCommand(definition.id)}
                        aria-keyshortcuts={ariaKeyShortcut(binding(definition.id))}
                        className="min-h-11 px-3"
                      >
                        <Icon className="size-4 shrink-0 text-secondary" />
                        <span className="min-w-0 flex-1 truncate">{definition.title}</span>
                        {opensMode ? (
                          <ChevronRight className="size-4 shrink-0 text-tertiary" />
                        ) : (
                          <Shortcut commandId={definition.id} />
                        )}
                      </PaletteResultItem>
                    );
                  })
                : null}

              {palette.mode === "root"
                ? rootAppearance.map((item) => (
                    <PaletteResultItem
                      key={item.mode}
                      result={item.result}
                      onSelect={() => void setAppearance(item.mode)}
                      aria-current={appearanceMode === item.mode ? "true" : undefined}
                      className="min-h-11 px-3"
                    >
                      <item.icon className="size-4 shrink-0 text-secondary" />
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      {appearanceMode === item.mode ? (
                        <>
                          <span className="sr-only">Current</span>
                          <Check aria-hidden="true" className="ml-auto size-4 text-accent-text" />
                        </>
                      ) : null}
                    </PaletteResultItem>
                  ))
                : null}

              {palette.mode === "bots" ? (
                <>
                  {bots.isLoading ? (
                    <CommandItem forceMount disabled value="Loading Bots" className="min-h-11 px-3">
                      <RefreshCw className="size-4 animate-spin text-secondary" />
                      <span>Loading Bots…</span>
                    </CommandItem>
                  ) : null}
                  {botResults.map(({ bot, result }) => (
                    <PaletteResultItem
                      key={bot.id}
                      result={result}
                      onSelect={() => {
                        if (!allowNavigation()) return;
                        rememberCommand("bots.search");
                        close();
                        void navigate(botChatPath(bot.id));
                      }}
                      className="min-h-11 px-3"
                    >
                      <Bot className="size-4 shrink-0 text-secondary" />
                      <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                      {bot.description ? <ItemDetail>{bot.description}</ItemDetail> : null}
                    </PaletteResultItem>
                  ))}
                </>
              ) : null}

              {palette.mode === "chats" ? (
                <>
                  <PaletteResultItem
                    result={newChatResult}
                    onSelect={() => runCommand("chat.new")}
                    aria-keyshortcuts={ariaKeyShortcut(binding("chat.new"))}
                    className="mb-1 min-h-11 px-3"
                  >
                    <MessageSquare className="size-4 text-secondary" />
                    <span>New chat</span>
                    {canExecute("chat.new") ? (
                      <Shortcut commandId="chat.new" />
                    ) : (
                      <ItemDetail>Open a workspace first</ItemDetail>
                    )}
                  </PaletteResultItem>
                  {chats.isLoading ? (
                    <CommandItem
                      forceMount
                      disabled
                      value="Loading chats"
                      className="min-h-11 px-3"
                    >
                      <RefreshCw className="size-4 animate-spin text-secondary" />
                      <span>Loading chats…</span>
                    </CommandItem>
                  ) : null}
                  {chats.isError ? (
                    <PaletteResultItem
                      result={chatRetryResult}
                      onSelect={() => void chats.refetch()}
                      className="min-h-11 px-3"
                    >
                      <RefreshCw className="size-4 text-secondary" />
                      <span>Chats could not be loaded</span>
                      <ItemDetail>Retry</ItemDetail>
                    </PaletteResultItem>
                  ) : null}
                  {chatResults.map(({ chat, result }) => (
                      <PaletteResultItem
                        key={chat.id}
                        result={result}
                        onSelect={() => void openChat(chat.id)}
                        className="min-h-11 px-3"
                      >
                        <Clock3 className="size-4 shrink-0 text-secondary" />
                        <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                        <ItemDetail>{new Date(chat.updatedAt).toLocaleDateString()}</ItemDetail>
                      </PaletteResultItem>
                    ))}
                </>
              ) : null}

              {palette.mode === "newChatIn" && pathIntake.pathQuery ? (
                pathRow && pathRowResult && pathRow.action !== "invalid" ? (
                  <PaletteResultItem
                    result={pathRowResult}
                    onSelect={() => choosePathRow(pathRow)}
                    data-path-row={pathRow.action}
                    className="min-h-11 px-3"
                  >
                    {pathRow.action === "select" ? (
                      <Folder className="size-4 shrink-0 text-secondary" />
                    ) : (
                      <FolderPlus className="size-4 shrink-0 text-secondary" />
                    )}
                    <span className="min-w-0 flex-1 truncate" title={pathRow.path}>
                      {pathRow.label}
                    </span>
                    {pathRow.action !== "create" && pathRow.detail ? (
                      <ItemDetail>{pathRow.detail}</ItemDetail>
                    ) : null}
                  </PaletteResultItem>
                ) : pathRow?.action === "invalid" ? (
                  <p role="status" data-path-row="invalid" className="flex items-start gap-2 px-3 py-3 text-small text-secondary">
                    <CircleAlert className="mt-px size-4 shrink-0 text-tertiary" />
                    <span className="min-w-0 flex-1">{pathRow.message}</span>
                  </p>
                ) : (
                  <p role="status" className="flex items-center gap-2 px-3 py-3 text-small text-tertiary">
                    <RefreshCw className="size-4 shrink-0 animate-spin" />
                    Checking path…
                  </p>
                )
              ) : palette.mode === "newChatIn" ? (
                <>
                  {workspaceResults.map(({ workspace, name, current, result }) => (
                    <PaletteResultItem
                      key={workspace.id}
                      result={result}
                      onSelect={() => startChatIn(workspace.id)}
                      aria-current={current ? "true" : undefined}
                      className="min-h-11 px-3"
                    >
                      <Folder className="size-4 shrink-0 text-secondary" />
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="min-w-0 shrink truncate">{name}</span>
                        {workspace.folderPath ? (
                          <span
                            className="min-w-0 flex-1 truncate text-small text-tertiary"
                            title={workspace.folderPath}
                          >
                            {formatWorkspacePath(
                              workspace.folderPath,
                              pathPreferences.workspacePathFormat,
                              48,
                            )}
                          </span>
                        ) : null}
                      </span>
                      {current ? (
                        <span className="shrink-0 text-small text-tertiary">current</span>
                      ) : null}
                    </PaletteResultItem>
                  ))}
                  {noWorkspaceHomeId ? (
                    <PaletteResultItem
                      result={noWorkspaceResult}
                      onSelect={() => startChatIn(noWorkspaceHomeId)}
                      aria-current={noWorkspaceCurrent ? "true" : undefined}
                      className="mt-1 min-h-11 px-3"
                    >
                      <MessageCircle className="size-4 shrink-0 text-secondary" />
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="min-w-0 shrink truncate">{NO_WORKSPACE_LABEL}</span>
                        <span className="min-w-0 flex-1 truncate text-small text-tertiary">
                          Just chat, with your global settings
                        </span>
                      </span>
                      {noWorkspaceCurrent ? (
                        <span className="shrink-0 text-small text-tertiary">current</span>
                      ) : null}
                    </PaletteResultItem>
                  ) : null}
                  <PaletteResultItem
                    result={openFolderResult}
                    onSelect={openFolderForChat}
                    className={noWorkspaceHomeId ? "min-h-11 px-3" : "mt-1 min-h-11 px-3"}
                  >
                    <FolderPlus className="size-4 shrink-0 text-secondary" />
                    <span className="min-w-0 flex-1 truncate">Open folder…</span>
                    <Shortcut commandId="workspace.openFolder" />
                  </PaletteResultItem>
                  <PaletteResultItem
                    result={cloneResult}
                    onSelect={cloneForChat}
                    className="min-h-11 px-3"
                  >
                    <FolderDown className="size-4 shrink-0 text-secondary" />
                    <span className="min-w-0 flex-1 truncate">Clone repository…</span>
                  </PaletteResultItem>
                </>
              ) : null}

              {palette.mode === "models" ? (
                providers.isLoading ? (
                  <CommandItem forceMount disabled value="Loading models" className="min-h-11 px-3">
                    <RefreshCw className="size-4 animate-spin text-secondary" />
                    <span>Loading models…</span>
                  </CommandItem>
                ) : providers.isError ? (
                  <PaletteResultItem
                    result={modelRetryResult}
                    onSelect={() => void providers.refetch()}
                    className="min-h-11 px-3"
                  >
                    <RefreshCw className="size-4 text-secondary" />
                    <span>Models could not be loaded</span>
                    <ItemDetail>Retry</ItemDetail>
                  </PaletteResultItem>
                ) : (
                  modelResults
                    .map(({ entry, result }) => {
                      const selected =
                        currentModel.providerId === entry.providerId &&
                        currentModel.model === entry.model;
                      return (
                        <PaletteResultItem
                          key={entry.value}
                          result={result}
                          onSelect={() => void selectModel(entry.providerId, entry.model)}
                          aria-current={selected ? "true" : undefined}
                          className="min-h-11 px-3"
                        >
                          <Bot className="size-4 shrink-0 text-secondary" />
                          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                          <ItemDetail>{entry.providerLabel}</ItemDetail>
                          {selected ? (
                            <>
                              <span className="sr-only">Current</span>
                              <Check aria-hidden="true" className="size-4 shrink-0 text-accent-text" />
                            </>
                          ) : null}
                        </PaletteResultItem>
                      );
                    })
                    .concat(
                      unavailableResults.map(({ provider, result }) => (
                        <PaletteResultItem
                          key={`unavailable-${provider.id}`}
                          result={result}
                          onSelect={() => {
                            if (!allowNavigation()) return;
                            rememberCommand("model.change");
                            close();
                            void navigate({
                              to: "/settings",
                              search: { section: "providers" },
                            });
                          }}
                          className="min-h-11 px-3"
                        >
                          <Server className="size-4 shrink-0 text-secondary" />
                          <span className="min-w-0 flex-1 truncate">{provider.label} models</span>
                          <ItemDetail>
                            {provider.models.length > 0 ? "Setup needed" : "No models available"}
                          </ItemDetail>
                          <ChevronRight className="size-4 shrink-0 text-tertiary" />
                        </PaletteResultItem>
                      )),
                    )
                )
              ) : null}

              {palette.mode === "providers" ? (
                <>
                  <PaletteResultItem
                    result={refreshResult}
                    onSelect={() => void refreshProviders()}
                    className="mb-1 min-h-11 px-3"
                  >
                    <RefreshCw className={cn("size-4 text-secondary", busy && "animate-spin")} />
                    <span>{busy ? "Refreshing providers…" : "Refresh provider catalogs"}</span>
                  </PaletteResultItem>
                  {providers.isLoading ? (
                    <CommandItem
                      forceMount
                      disabled
                      value="Loading providers"
                      className="min-h-11 px-3"
                    >
                      <RefreshCw className="size-4 animate-spin text-secondary" />
                      <span>Loading providers…</span>
                    </CommandItem>
                  ) : null}
                  {providers.isError ? (
                    <PaletteResultItem
                      result={providerRetryResult}
                      onSelect={() => void providers.refetch()}
                      className="min-h-11 px-3"
                    >
                      <RefreshCw className="size-4 text-secondary" />
                      <span>Providers could not be loaded</span>
                      <ItemDetail>Retry</ItemDetail>
                    </PaletteResultItem>
                  ) : null}
                  {providerResults.map(({ provider, result }) => (
                    <PaletteResultItem
                      key={provider.id}
                      result={result}
                      onSelect={() => {
                        if (!allowNavigation()) return;
                        close();
                        void navigate({
                          to: "/settings",
                          search: { section: "providers" },
                        });
                      }}
                      className="min-h-11 px-3"
                    >
                      <Server className="size-4 shrink-0 text-secondary" />
                      <span className="min-w-0 flex-1 truncate">{provider.label}</span>
                      <ItemDetail>
                        {provider.hasKey || !provider.needsKey ? "Connected" : "Setup needed"}
                      </ItemDetail>
                      <ChevronRight className="size-4 shrink-0 text-tertiary" />
                    </PaletteResultItem>
                  ))}
                </>
              ) : null}

              {palette.mode === "settings" ? (
                <>
                  {appearanceResults.map((item, index) => (
                    <PaletteResultItem
                      key={item.mode}
                      result={item.result}
                      onSelect={() => void setAppearance(item.mode)}
                      aria-current={appearanceMode === item.mode ? "true" : undefined}
                      className={cn("min-h-11 px-3", index === 2 && "mb-1")}
                    >
                      <item.icon className="size-4 text-secondary" />
                      <span>{item.title}</span>
                      {appearanceMode === item.mode ? (
                        <>
                          <span className="sr-only">Current</span>
                          <Check aria-hidden="true" className="ml-auto size-4 text-accent-text" />
                        </>
                      ) : null}
                    </PaletteResultItem>
                  ))}
                  {settingsResults.map(({ destination, result }) => (
                    <PaletteResultItem
                      key={destination.id}
                      result={result}
                      onSelect={() => {
                        if (!allowNavigation()) return;
                        close();
                        void navigate({
                          to: "/settings",
                          search: { section: destination.id },
                        });
                      }}
                      className="min-h-11 px-3"
                    >
                      <Settings className="size-4 shrink-0 text-secondary" />
                      <span className="min-w-0 flex-1 truncate">{destination.title}</span>
                      <ItemDetail>{destination.group}</ItemDetail>
                      <ChevronRight className="size-4 shrink-0 text-tertiary" />
                    </PaletteResultItem>
                  ))}
                </>
              ) : null}
            </CommandList>
            {palette.mode === "newChatIn" ? (
              <p className="px-5 pb-3 pt-1 text-mini text-tertiary" data-new-chat-in-footer>
                ⌥↵ in a new worktree
              </p>
            ) : null}
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
