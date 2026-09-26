import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Keyboard,
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
import {
  COMMANDS,
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
import { useChats, useProviders, useSettings, queryKeys } from "../lib/queries";
import { useActiveWorkspace } from "../lib/workspace-context";
import { providersApi, settingsApi } from "../lib/ipc";
import { readModelSelectionRevision, useModelSelection } from "../lib/use-model-selection";
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
  const { activeId } = useActiveWorkspace();
  const chats = useChats(activeId);
  const providers = useProviders();
  const settings = useSettings();
  const selection = useModelSelection(
    providers.data,
    settings.data?.hiddenModelsByProvider,
    settings.data !== undefined,
  );
  const { binding, canExecute, execute, palette } = useCommandSystem();
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
  const rootCommands = React.useMemo(() => {
    const order = new Map(recentCommands.map((id, index) => [id, index]));
    return COMMANDS.filter((definition) => definition.showInPalette).sort(
      (left, right) =>
        (order.get(left.id) ?? Number.POSITIVE_INFINITY) -
        (order.get(right.id) ?? Number.POSITIVE_INFINITY),
    );
  }, [recentCommands]);
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
  const resultsByMode: Record<CommandPaletteMode, PaletteResult[]> = {
    root: rootResults.map(({ result }) => result),
    chats: [
      newChatResult,
      ...(chats.isError ? [chatRetryResult] : []),
      ...chatResults.map(({ result }) => result),
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
      if (commandId === "model.change") return enterMode("models");
      if (commandId === "provider.manage") return enterMode("providers");
      if (commandId === "settings.search") return enterMode("settings");
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

  const selectModel = async (providerId: string, model: string) => {
    const epoch = ++modelSelectionEpoch.current;
    const selectionRevision = readModelSelectionRevision();
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
      selection.select(providerId, model);
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
                  : `Search ${MODE_LABELS[palette.mode].toLocaleLowerCase()}…`
              }
              aria-label={`Search ${MODE_LABELS[palette.mode].toLocaleLowerCase()}`}
              className="h-11"
              onKeyDown={(event) => {
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
              <CommandEmpty>
                <Search className="mx-auto mb-2 size-5 text-tertiary" />
                No {MODE_LABELS[palette.mode].toLocaleLowerCase()} match “{query.trim()}”.
              </CommandEmpty>

              {palette.mode === "root"
                ? rootResults.map(({ definition, result }) => {
                    const Icon = CATEGORY_ICON[definition.category];
                    const opensMode = [
                      "chat.search",
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
                        selection.providerId === entry.providerId &&
                        selection.model === entry.model;
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
                              <Check aria-hidden="true" className="size-4 shrink-0 text-accent" />
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
                          <Check aria-hidden="true" className="ml-auto size-4 text-accent" />
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
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
