import * as React from "react";
import { Download, Pencil, Plus, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";

import {
  AlertDialog,
  Badge,
  Button,
  Dialog,
  Field,
  FieldSet,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
  type BadgeColor,
} from "../ui";
import { InfoHint } from "../ui-info-hint";
import { Progress } from "../ui-primitives";
import { botComputersApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { useBots } from "../../lib/queries";
import { useBotComputersCache, useBotComputersStatus } from "../../lib/use-bot-computers";
import {
  approximateBotComputerBytes,
  BOT_COMPUTER_DEFAULT_MODE_CHOICES,
  BOT_COMPUTER_IDLE_STOP_CHOICES,
  botComputerMaxRunningChoices,
  botComputerSetupBusy,
  botComputerSetupPercent,
  botComputerSetupSummary,
  botComputersMigrationNoticeText,
  formatBotComputerBytes,
  type BotComputerDefaultMode,
  type BotComputerMaxRunning,
  type BotComputerRunState,
  type BotComputersRequirements,
  type BotComputersSettings as BotComputersSettingsValue,
  type BotComputerVmStatus,
} from "../../shared/bot-computers";

/** Memory as macOS states it: binary gigabytes ("4 GB"). */
export function botComputerMemoryLabel(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024 ** 3))} GB`;
}

/** What Set up downloads, from where and how much space it needs, before the person chooses it. */
export function botComputersSetupDisclosure(requirements: BotComputersRequirements): string {
  return (
    `Set up downloads Debian ${requirements.baseVersion} (${approximateBotComputerBytes(requirements.downloadBytes)}, plus desktop packages) ` +
    `and builds a base computer of ${approximateBotComputerBytes(requirements.baseDiskBytes)}. ` +
    `It needs ${approximateBotComputerBytes(requirements.setupFreeBytes)} free while it works, and the download is deleted once the base is ready. ` +
    "Nothing is downloaded until you choose Set up."
  );
}

function idleLabel(minutes: number): string {
  return minutes === 60 ? "1 hour" : `${minutes} minutes`;
}

function defaultModeLabel(mode: BotComputerDefaultMode): string {
  return mode === "shared" ? "Shared computer" : "New computer for each Bot";
}

function vmStateBadge(state: BotComputerRunState): { label: string; color: BadgeColor } {
  switch (state) {
    case "running":
      return { label: "Running", color: "green" };
    case "starting":
      return { label: "Starting…", color: "blue" };
    case "stopping":
      return { label: "Stopping…", color: "blue" };
    case "waiting_for_slot":
      return { label: "Waiting", color: "blue" };
    case "stale":
      return { label: "Needs reset", color: "red" };
    case "stopped":
      return { label: "Stopped", color: "gray" };
  }
}

type Action =
  | "setUp"
  | "cancel"
  | "updateBase"
  | "remove"
  | "settings"
  | "dismissNotice"
  | "createVm"
  | "renameVm"
  | "resetVm"
  | "deleteVm";

/**
 * Settings → Computers & VMs → Bot computers: the one place the Debian Linux
 * base computer is set up, sized and removed. Nothing is downloaded until the
 * person chooses Set up, and the size and source are stated before that.
 */
export function BotComputersSettings() {
  const query = useBotComputersStatus();
  const cache = useBotComputersCache();
  const [acting, setActing] = React.useState<Action | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createName, setCreateName] = React.useState("");
  const [renameTarget, setRenameTarget] = React.useState<BotComputerVmStatus | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [resetTarget, setResetTarget] = React.useState<BotComputerVmStatus | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<BotComputerVmStatus | null>(null);
  const actionCellRef = React.useRef<HTMLDivElement>(null);
  const focusedInActionRef = React.useRef(false);
  const status = query.data;
  const setupKind = status?.setup.kind;
  const needsBotNames = Boolean(
    status &&
      status.setup.kind !== "unsupported" &&
      status.vms.some((vm) => vm.assignedBotIds.length > 0 || vm.activeBotId !== undefined || vm.queuedBotIds.length > 0),
  );
  const botsQuery = useBots(false, needsBotNames);
  const botNames = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const bot of botsQuery.data ?? []) map.set(bot.id, bot.name);
    return map;
  }, [botsQuery.data]);

  // Set up, Cancel, Try again and Update base replace one another in the same
  // place; when the focused one unmounts, focus moves to whichever replaced it
  // rather than dropping to the page.
  React.useLayoutEffect(() => {
    const cell = actionCellRef.current;
    if (!cell || !focusedInActionRef.current) return;
    const active = cell.ownerDocument.activeElement;
    if (active && active !== cell.ownerDocument.body && cell.contains(active)) return;
    const next = cell.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (next) next.focus();
  }, [setupKind, acting]);

  if (!query.supported) {
    return (
      <FieldSet>
        <Field label="Not available on this computer" description="Bot computers need a Mac with Apple silicon." />
      </FieldSet>
    );
  }
  if (!status) {
    return query.isError ? (
      <FieldSet>
        <Field
          label="Couldn't check Bot computers"
          description={userFacingErrorMessage(query.error, "Aiden couldn't read the Bot computer status.")}
        >
          <Button size="small" variant="filled" onClick={() => void query.refetch()}>
            <RefreshCw /> Try again
          </Button>
        </Field>
      </FieldSet>
    ) : (
      <Text as="p" variant="small" color="tertiary" aria-live="polite">
        Checking Bot computers…
      </Text>
    );
  }

  const run = async (action: Action, operation: () => Promise<void>, failure: string) => {
    setActing(action);
    try {
      await operation();
    } catch (error) {
      toast.error(userFacingErrorMessage(error, failure));
      void cache.refresh();
    } finally {
      setActing(null);
    }
  };

  const setUp = () =>
    run("setUp", async () => cache.set(await botComputersApi.setUp()), "Aiden couldn't start setting up Bot computers.");
  const updateBase = () =>
    run("updateBase", async () => cache.set(await botComputersApi.updateBase()), "Aiden couldn't start updating the base.");
  const cancel = () =>
    run(
      "cancel",
      async () => {
        await botComputersApi.cancelSetUp();
        await cache.refresh();
      },
      "Aiden couldn't cancel setup.",
    );
  const dismissMigrationNotice = () =>
    run(
      "dismissNotice",
      async () => {
        await botComputersApi.dismissMigrationNotice();
        cache.update((current) => {
          const next = { ...current };
          delete next.migrationNotice;
          return next;
        });
      },
      "Aiden couldn't dismiss this notice.",
    );
  const downloadLabel = "Downloading Debian Linux";

  const removeEverything = () =>
    run(
      "remove",
      async () => {
        cache.set(await botComputersApi.removeEverything());
        toast.success("Every Bot computer and the Linux download are removed.");
      },
      "Aiden couldn't remove the Bot computers.",
    );
  const changeSettings = (patch: Partial<BotComputersSettingsValue>) => {
    const previous = status.settings;
    cache.update((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
    void run(
      "settings",
      async () => {
        try {
          const settings = await botComputersApi.updateSettings(patch);
          cache.update((current) => ({ ...current, settings }));
        } catch (error) {
          cache.update((current) => ({ ...current, settings: previous }));
          throw error;
        }
      },
      "Aiden couldn't save this setting.",
    );
  };

  const createComputer = () => {
    const trimmed = createName.trim();
    void run(
      "createVm",
      async () => {
        const vm = await botComputersApi.createComputer(trimmed || undefined);
        cache.putVm(vm);
        setCreateOpen(false);
        setCreateName("");
        void cache.refresh();
      },
      "Aiden couldn't create a new Linux computer.",
    );
  };
  const renameComputer = () => {
    if (!renameTarget) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    const target = renameTarget;
    void run(
      "renameVm",
      async () => {
        const vm = await botComputersApi.renameComputer(target.id, trimmed);
        cache.putVm(vm);
        setRenameTarget(null);
        void cache.refresh();
      },
      `Aiden couldn't rename ${target.name}.`,
    );
  };
  const resetComputer = (vm: BotComputerVmStatus) =>
    run(
      "resetVm",
      async () => {
        const updated = await botComputersApi.resetComputer(vm.id);
        cache.putVm(updated);
        void cache.refresh();
      },
      `Aiden couldn't reset ${vm.name}.`,
    );
  const deleteComputer = (vm: BotComputerVmStatus) =>
    run(
      "deleteVm",
      async () => {
        await botComputersApi.deleteComputer(vm.id, vm.assignedBotIds.length > 0 ? { force: true } : undefined);
        cache.dropVm(vm.id);
        void cache.refresh();
      },
      `Aiden couldn't delete ${vm.name}.`,
    );

  const setup = status.setup;
  const unsupported = setup.kind === "unsupported";
  const busy = botComputerSetupBusy(setup);
  const percent = botComputerSetupPercent(setup);
  const summary = botComputerSetupSummary(setup);
  const offerSetUp = setup.kind === "not_set_up" || setup.kind === "failed";
  const hasAnything = setup.kind !== "not_set_up" || status.diskUsedBytes > 0 || status.vms.length > 0 || status.computers.length > 0;
  const memory = botComputerMemoryLabel(status.requirements.memoryPerComputerBytes);
  const maxRunningLimit: BotComputerMaxRunning = status.requirements.maxRunningLimit ?? 4;
  const maxRunningChoices = botComputerMaxRunningChoices(maxRunningLimit);
  const displayedMaxRunning = Math.min(status.settings.maxRunning, maxRunningLimit);
  const computerCount = status.vms.length > 0 ? status.vms.length : status.computers.length;
  const showComputersSection = !unsupported && (setup.kind === "ready" || status.vms.length > 0);

  const formatAssignedBots = (vm: BotComputerVmStatus): string => {
    if (vm.assignedBotIds.length === 0) return "Not assigned";
    const resolved = vm.assignedBotIds.map((id) => botNames.get(id)).filter((name): name is string => Boolean(name));
    if (resolved.length === vm.assignedBotIds.length) {
      return resolved.length <= 3 ? resolved.join(", ") : `${resolved.slice(0, 2).join(", ")} +${resolved.length - 2}`;
    }
    return vm.assignedBotIds.length === 1 ? "1 Bot" : `${vm.assignedBotIds.length} Bots`;
  };

  return (
    <>
      {status.migrationNotice ? (
        <FieldSet>
          <Field
            label="Switched to Linux"
            description={
              <span role="status" className="block">
                {botComputersMigrationNoticeText(status.migrationNotice.freedBytes)}
              </span>
            }
          >
            <Button
              size="small"
              variant="transparent"
              disabled={acting !== null}
              onClick={() => void dismissMigrationNotice()}
            >
              <X aria-hidden /> Dismiss
            </Button>
          </Field>
        </FieldSet>
      ) : null}

      <FieldSet title="Setup">
        <Field
          label="Base computer"
          description={
            <>
              <span className="block">{summary}</span>
              {offerSetUp ? <span className="mt-1 block text-tertiary">{botComputersSetupDisclosure(status.requirements)}</span> : null}
              {setup.kind === "ready" ? (
                <span className="mt-1 block text-tertiary">
                  Give a Bot its own computer from its profile. Each one starts as a copy of this base.
                </span>
              ) : null}
            </>
          }
        >
          <div
            ref={actionCellRef}
            className="flex flex-wrap justify-end gap-2"
            onFocus={() => {
              focusedInActionRef.current = true;
            }}
            onBlur={(event) => {
              // An unmounting button blurs with no next target; that focus is still ours to place.
              if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
                focusedInActionRef.current = false;
              }
            }}
          >
            {offerSetUp ? (
              <Button size="small" variant="accent" disabled={acting !== null} onClick={() => void setUp()}>
                {setup.kind === "failed" ? <RotateCcw /> : <Download />}
                {setup.kind === "failed" ? "Try again" : "Set up"}
              </Button>
            ) : null}
            {busy ? (
              <Button size="small" variant="transparent" disabled={acting === "cancel"} onClick={() => void cancel()}>
                <X /> Cancel
              </Button>
            ) : null}
            {setup.kind === "ready" && setup.updateAvailable ? (
              <Button size="small" variant="accent" disabled={acting !== null} onClick={() => void updateBase()}>
                <Download /> Update base
              </Button>
            ) : null}
          </div>
        </Field>
        {busy ? (
          <Field orientation="vertical">
            {/* Only the download has a percentage; the other steps are named above. */}
            {percent !== null ? (
              <Progress value={percent} label={downloadLabel} />
            ) : (
              <Progress indeterminate label={summary} />
            )}
          </Field>
        ) : null}
        {/* Announce what setup is doing; the bar carries the percentage. */}
        <span className="sr-only" aria-live="polite">
          {setup.kind === "downloading" ? downloadLabel : summary}
        </span>
      </FieldSet>

      {showComputersSection ? (
        <FieldSet
          title="Computers"
          action={
            <Button
              size="small"
              variant="transparent"
              disabled={setup.kind !== "ready" || busy || acting !== null}
              onClick={() => {
                setCreateName("");
                setCreateOpen(true);
              }}
            >
              <Plus aria-hidden /> New computer
            </Button>
          }
        >
          {status.vms.length === 0 ? (
            <Field
              label="No computers yet"
              description="Giving a Bot a computer clones the shared Linux computer automatically, or you can create one here."
            />
          ) : (
            status.vms.map((vm) => {
              const badge = vmStateBadge(vm.state);
              const details: string[] = [formatAssignedBots(vm)];
              if (vm.diskUsedBytes !== undefined) details.push(formatBotComputerBytes(vm.diskUsedBytes));
              if (vm.activeBotId) {
                const holder = botNames.get(vm.activeBotId) ?? "a Bot";
                const waiting = vm.queuedBotIds.length > 0 ? ` · ${vm.queuedBotIds.length} waiting` : "";
                details.push(`In use by ${holder}${waiting}`);
              }
              return (
                <Field
                  key={vm.id}
                  label={
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <span>{vm.name}</span>
                      <Badge color={vm.kind === "shared" ? "blue" : "gray"}>
                        {vm.kind === "shared" ? "Shared" : "Dedicated"}
                      </Badge>
                      <Badge color={badge.color}>{badge.label}</Badge>
                      {vm.outdated ? <Badge color="warning">Outdated</Badge> : null}
                    </span>
                  }
                  description={details.join(" · ")}
                >
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="small"
                      variant="transparent"
                      aria-label={`Rename ${vm.name}`}
                      disabled={acting !== null}
                      onClick={() => {
                        setRenameTarget(vm);
                        setRenameValue(vm.name);
                      }}
                    >
                      <Pencil aria-hidden /> Rename
                    </Button>
                    <Button
                      size="small"
                      variant={vm.state === "stale" || vm.outdated ? "filled" : "transparent"}
                      aria-label={`Reset ${vm.name}`}
                      disabled={acting !== null || vm.state === "stopping"}
                      onClick={() => setResetTarget(vm)}
                    >
                      <RotateCcw aria-hidden /> Reset
                    </Button>
                    <Button
                      size="small"
                      variant="transparent"
                      aria-label={`Delete ${vm.name}`}
                      disabled={acting !== null || vm.state === "stopping"}
                      onClick={() => setDeleteTarget(vm)}
                    >
                      <Trash2 aria-hidden /> Delete
                    </Button>
                  </div>
                </Field>
              );
            })
          )}
        </FieldSet>
      ) : null}

      {unsupported ? null : (
        <FieldSet title="Running">
          <Field
            label="Default for new Bots"
            description="Bots on a shared computer take turns automatically, with a shared folder and their own folders."
          >
            <Select
              value={status.settings.defaultComputerMode}
              disabled={acting === "settings"}
              onValueChange={(value) => changeSettings({ defaultComputerMode: value as BotComputerDefaultMode })}
            >
              <SelectTrigger aria-label="Default for new Bots" className="max-w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BOT_COMPUTER_DEFAULT_MODE_CHOICES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {defaultModeLabel(mode)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Computers running at once"
            hint={<InfoHint topic="running limit">At the limit, the computer used longest ago stops, or the next Bot waits its turn.</InfoHint>}
            description={`Each running computer uses about ${memory} of memory.`}
          >
            <Select
              value={String(displayedMaxRunning)}
              disabled={acting === "settings"}
              onValueChange={(value) => changeSettings({ maxRunning: Number(value) as BotComputerMaxRunning })}
            >
              <SelectTrigger aria-label="Computers running at once" className="max-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {maxRunningChoices.map((choice) => (
                  <SelectItem key={choice} value={String(choice)}>
                    {choice === 1 ? "1 computer" : `${choice} computers`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Stop when idle"
            description="An unused computer stops after this long, and starts again when its Bot needs it."
          >
            <Select
              value={String(status.settings.idleStopMinutes)}
              disabled={acting === "settings"}
              onValueChange={(value) => changeSettings({ idleStopMinutes: Number(value) })}
            >
              <SelectTrigger aria-label="Stop when idle" className="max-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BOT_COMPUTER_IDLE_STOP_CHOICES.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {idleLabel(minutes)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldSet>
      )}

      {unsupported ? null : (
        <FieldSet title="Storage">
          <Field
            label="Disk used"
            description={
              computerCount === 0
                ? "The base computer and any download in progress."
                : `The base computer and ${computerCount === 1 ? "1 Bot computer" : `${computerCount} Bot computers`}.`
            }
          >
            <Text variant="small" color="secondary" className="justify-self-end tabular-nums">
              {formatBotComputerBytes(status.diskUsedBytes)}
              {status.freeDiskBytes !== undefined ? ` · ${formatBotComputerBytes(status.freeDiskBytes)} free` : ""}
            </Text>
          </Field>
          <Field
            label="Remove everything"
            description="Stops and deletes every Bot computer, the base and the Linux download. Files in each Bot's Computer folder stay."
          >
            <Button
              size="small"
              variant="transparent"
              disabled={!hasAnything || busy || acting !== null}
              onClick={() => setConfirmRemove(true)}
            >
              <Trash2 /> Remove everything
            </Button>
          </Field>
        </FieldSet>
      )}

      <AlertDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove every Bot computer?"
        description="Aiden stops and deletes every Bot's computer, the base computer, the Linux download and the keys it uses to reach them. Files in each Bot's Computer folder stay. To use Bot computers again, choose Set up and download Debian Linux again."
        confirmLabel="Remove everything"
        confirmVariant="destructive"
        busy={acting === "remove"}
        onConfirm={() => {
          setConfirmRemove(false);
          void removeEverything();
        }}
      />

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New computer"
        description="Creates a fresh Debian Linux computer cloned from the base."
        confirmLabel="Create computer"
        busy={acting === "createVm"}
        submitOnEnter
        onConfirm={createComputer}
      >
        <Input
          aria-label="Computer name"
          placeholder="Optional name (e.g. Research Linux)"
          maxLength={64}
          value={createName}
          onChange={(event) => setCreateName(event.target.value)}
        />
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => !open && setRenameTarget(null)}
        title={renameTarget ? `Rename ${renameTarget.name}` : "Rename computer"}
        confirmLabel="Save name"
        confirmDisabled={renameValue.trim().length === 0}
        busy={acting === "renameVm"}
        submitOnEnter
        onConfirm={renameComputer}
      >
        <Input
          aria-label="Computer name"
          maxLength={64}
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
        />
      </Dialog>

      <AlertDialog
        open={resetTarget !== null}
        onOpenChange={(open) => !open && setResetTarget(null)}
        title={resetTarget ? `Reset ${resetTarget.name}?` : "Reset computer?"}
        description={
          resetTarget && resetTarget.assignedBotIds.length > 1
            ? `Aiden deletes everything on ${resetTarget.name} and clones a fresh copy of the base for all ${resetTarget.assignedBotIds.length} assigned Bots. Files in shared and per-Bot folders stay.`
            : "Aiden deletes everything on this computer and makes a fresh copy of the base. Files in shared and per-Bot folders stay."
        }
        confirmLabel="Reset computer"
        confirmVariant="destructive"
        busy={acting === "resetVm"}
        onConfirm={() => {
          const target = resetTarget;
          setResetTarget(null);
          if (target) void resetComputer(target);
        }}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : "Delete computer?"}
        description={
          deleteTarget && deleteTarget.assignedBotIds.length > 0
            ? `${deleteTarget.assignedBotIds.length === 1 ? "1 Bot is" : `${deleteTarget.assignedBotIds.length} Bots are`} currently assigned to ${deleteTarget.name}. Deleting it stops and removes the virtual machine and unassigns those Bots. Files in shared and per-Bot folders stay.`
            : "Aiden stops and deletes this virtual machine. Files in shared and per-Bot folders stay."
        }
        confirmLabel="Delete computer"
        confirmVariant="destructive"
        busy={acting === "deleteVm"}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) void deleteComputer(target);
        }}
      />
    </>
  );
}
