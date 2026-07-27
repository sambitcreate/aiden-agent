import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Keyboard, RotateCcw, Search } from "lucide-react";
import { Badge, Button, Callout, FieldSet, Input, Switch, Text, toast } from "../ui";
import { shortcutApi } from "../../lib/ipc";
import { queryKeys, useShortcuts } from "../../lib/queries";
import {
  COMMANDS,
  acceleratorFromKeyboardEvent,
  ariaKeyShortcut,
  prettyAccelerator,
  type CommandDefinition,
  type CommandId,
  type KeybindingMutation,
  type KeybindingSnapshot,
} from "../../shared/keybindings";

function RuntimeBadge({
  command,
  snapshot,
}: {
  command: CommandDefinition;
  snapshot: KeybindingSnapshot;
}) {
  if (!command.global) return <Badge>In app</Badge>;
  const status = snapshot.global.find((entry) => entry.commandId === command.id);
  if (status?.state === "active") return <Badge color="green">Global · Active</Badge>;
  if (status?.state === "unavailable") return <Badge color="red">Global · Unavailable</Badge>;
  return <Badge>Global · Off</Badge>;
}

function ShortcutRow({
  command,
  snapshot,
  recording,
  saving,
  onRecord,
  onCancelRecord,
  onApply,
}: {
  command: CommandDefinition;
  snapshot: KeybindingSnapshot;
  recording: boolean;
  saving: boolean;
  onRecord: () => void;
  onCancelRecord: () => void;
  onApply: (mutation: KeybindingMutation) => Promise<void>;
}) {
  const binding = snapshot.effective[command.id];
  const retainedBinding = snapshot.overrides.commands[command.id]?.binding;
  const canEnable =
    binding !== null ||
    (retainedBinding !== null && retainedBinding !== undefined) ||
    command.defaultBinding !== null;
  const overridden = command.id in snapshot.overrides.commands;
  const status = snapshot.global.find((entry) => entry.commandId === command.id);
  const source =
    binding === null
      ? "Disabled"
      : !overridden || binding === command.defaultBinding
        ? "Default"
        : "Custom";
  const recorderRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (recording) requestAnimationFrame(() => recorderRef.current?.focus());
  }, [recording]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancelRecord();
      return;
    }
    if (event.key === "Tab") {
      onCancelRecord();
      return;
    }
    event.preventDefault();
    const next = acceleratorFromKeyboardEvent(event);
    if (next) void onApply({ commandId: command.id, binding: next });
  };

  return (
    <div className="px-4 py-3.5 after:mt-3.5 after:block after:h-px after:bg-separator last:after:hidden">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Text variant="strong">{command.title}</Text>
            <RuntimeBadge command={command} snapshot={snapshot} />
            <Badge>{source}</Badge>
          </div>
          <Text as="p" variant="small" color="secondary" className="mt-0.5 max-w-[38rem]">
            {command.description}
          </Text>
        </div>
        <Switch
          checked={binding !== null}
          disabled={saving || !canEnable}
          onCheckedChange={(enabled) =>
            void onApply({ commandId: command.id, disabled: !enabled })
          }
          aria-label={`${binding ? "Disable" : "Enable"} ${command.title}`}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          ref={recorderRef}
          data-shortcut-recorder={recording ? "true" : undefined}
          aria-label={
            recording
              ? `Recording shortcut for ${command.title}`
              : `Change shortcut for ${command.title}`
          }
          variant={recording ? "accent" : "filled"}
          disabled={saving}
          onClick={() => (recording ? onCancelRecord() : onRecord())}
          onBlur={() => {
            if (recording) onCancelRecord();
          }}
          onKeyDown={onKeyDown}
          className="min-w-28 font-normal"
        >
          <Keyboard className="size-4" />
          {recording ? "Press keys…" : prettyAccelerator(binding)}
        </Button>
        {overridden ? (
          <Button
            size="small"
            variant="transparent"
            disabled={saving}
            onClick={() => void onApply({ commandId: command.id, reset: true })}
          >
            <RotateCcw className="size-3.5" />
            Reset
          </Button>
        ) : null}
        {recording ? (
          <Text role="status" variant="small" color="secondary">
            Press a modifier and key. Escape cancels; Tab moves on.
          </Text>
        ) : null}
      </div>
      {status?.state === "unavailable" && status.message ? (
        <div className="mt-2 flex items-start gap-1.5 text-small text-red" role="alert">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{status.message}</span>
        </div>
      ) : null}
    </div>
  );
}

export function ShortcutSettings() {
  const queryClient = useQueryClient();
  const shortcuts = useShortcuts();
  const [query, setQuery] = React.useState("");
  const [recordingId, setRecordingId] = React.useState<CommandId | null>(null);
  const [savingId, setSavingId] = React.useState<CommandId | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingReplacement, setPendingReplacement] = React.useState<{
    commandId: CommandId;
    binding: string;
  } | null>(null);

  const apply = async (mutation: KeybindingMutation) => {
    if (savingId) return;
    setSavingId(mutation.commandId);
    setError(null);
    setPendingReplacement(null);
    try {
      if (recordingId) {
        setRecordingId(null);
        const restored = await shortcutApi.setRecording(false);
        queryClient.setQueryData(queryKeys.shortcuts, restored);
      }
      const snapshot = await shortcutApi.set(mutation);
      queryClient.setQueryData(queryKeys.shortcuts, snapshot);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.assistantConfig }),
      ]);
      setRecordingId(null);
      toast.success(
        "binding" in mutation
          ? `${COMMANDS.find((item) => item.id === mutation.commandId)?.title} set to ${prettyAccelerator(mutation.binding)}`
          : "Shortcut updated",
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "The shortcut could not be updated.";
      setError(message);
      if ("binding" in mutation && message.includes("already used by")) {
        setPendingReplacement({
          commandId: mutation.commandId,
          binding: mutation.binding,
        });
      }
      toast.error(message);
    } finally {
      setSavingId(null);
    }
  };

  const beginRecording = async (commandId: CommandId) => {
    if (savingId || recordingId) return;
    setError(null);
    try {
      await shortcutApi.setRecording(true);
      setRecordingId(commandId);
    } catch (reason) {
      const message =
        reason instanceof Error
          ? reason.message
          : "Global shortcuts could not be released for recording.";
      setError(message);
      toast.error(message);
    }
  };

  const cancelRecording = async () => {
    if (!recordingId) return;
    setRecordingId(null);
    try {
      const snapshot = await shortcutApi.setRecording(false);
      queryClient.setQueryData(queryKeys.shortcuts, snapshot);
    } catch (reason) {
      const message =
        reason instanceof Error
          ? reason.message
          : "Global shortcuts could not be restored.";
      setError(message);
      toast.error(message);
    }
  };

  React.useEffect(
    () => () => {
      void shortcutApi.setRecording(false).catch(() => undefined);
    },
    [],
  );

  if (shortcuts.isError) {
    return (
      <Callout role="alert" color="red" className="flex-row items-center justify-between gap-4">
        <div>
          <Text variant="strong">Keyboard shortcuts are unavailable</Text>
          <Text as="p" variant="small" color="secondary">
            Retry before recording a shortcut.
          </Text>
        </div>
        <Button size="small" onClick={() => void shortcuts.refetch()}>
          Retry
        </Button>
      </Callout>
    );
  }

  if (shortcuts.isLoading || !shortcuts.data) {
    return (
      <FieldSet title="Keyboard shortcuts">
        <div className="px-4 py-8 text-center text-small text-secondary" role="status">
          Loading shortcuts…
        </div>
      </FieldSet>
    );
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = COMMANDS.filter(
    (command) => {
      const binding = shortcuts.data.effective[command.id];
      const searchText = [
        command.title,
        command.description,
        command.category,
        ...command.keywords,
        binding,
        prettyAccelerator(binding),
        ariaKeyShortcut(binding),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return (
        command.showInSettings &&
        (!normalizedQuery || searchText.includes(normalizedQuery))
      );
    },
  );
  const groups = [
    { title: "Global shortcuts", commands: visible.filter((command) => command.global) },
    { title: "In-app shortcuts", commands: visible.filter((command) => !command.global) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Text as="h1" variant="heading1">
          Keyboard shortcuts
        </Text>
        <Text as="p" color="secondary" className="mt-1 max-w-[42rem]">
          One command map powers the app, command palette, menus, and these controls.
          Global shortcuts work while Aiden is in the background.
        </Text>
      </div>

      <label className="flex h-9 items-center gap-2 rounded-control border border-field bg-background px-3 focus-within:border-focus-ring focus-within:bg-input">
        <Search className="size-4 text-tertiary" />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search shortcuts…"
          aria-label="Search keyboard shortcuts"
          className="h-full border-0 bg-transparent px-0 hover:border-0 focus:border-0 focus:bg-transparent"
        />
      </label>

      {error ? (
        <Callout role="alert" color="red">
          <Text variant="small-strong" color="red">
            Shortcut not changed
          </Text>
          <Text as="p" variant="small" color="secondary">
            {error}
          </Text>
          {pendingReplacement ? (
            <Button
              size="small"
              variant="filled"
              disabled={savingId !== null}
              onClick={() =>
                void apply({
                  ...pendingReplacement,
                  replace: true,
                })
              }
              className="mt-2"
            >
              Replace existing shortcut
            </Button>
          ) : null}
        </Callout>
      ) : null}
      <div className="sr-only" aria-live="polite">
        {recordingId
          ? `Recording ${COMMANDS.find((item) => item.id === recordingId)?.title}`
          : ""}
      </div>

      {groups.map((group) =>
        group.commands.length > 0 ? (
          <FieldSet key={group.title} title={group.title}>
            {group.commands.map((command) => (
              <ShortcutRow
                key={command.id}
                command={command}
                snapshot={shortcuts.data}
                recording={recordingId === command.id}
                saving={savingId !== null}
                onRecord={() => void beginRecording(command.id)}
                onCancelRecord={() => void cancelRecording()}
                onApply={apply}
              />
            ))}
          </FieldSet>
        ) : null,
      )}

      {visible.length === 0 ? (
        <Text role="status" color="secondary" className="py-8 text-center">
          No shortcuts match “{query.trim()}”.
        </Text>
      ) : null}
    </div>
  );
}
