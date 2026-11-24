import * as React from "react";
import { Download, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";

import {
  AlertDialog,
  Button,
  Field,
  FieldSet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "../ui";
import { InfoHint } from "../ui-info-hint";
import { Progress } from "../ui-primitives";
import { botComputersApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { useBotComputersCache, useBotComputersStatus } from "../../lib/use-bot-computers";
import {
  approximateBotComputerBytes,
  BOT_COMPUTER_IDLE_STOP_CHOICES,
  botComputerMaxRunningChoices,
  botComputerSetupBusy,
  botComputerSetupPercent,
  botComputerSetupSummary,
  botComputersMigrationNoticeText,
  formatBotComputerBytes,
  type BotComputerMaxRunning,
  type BotComputersRequirements,
  type BotComputersSettings as BotComputersSettingsValue,
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

type Action = "setUp" | "cancel" | "updateBase" | "remove" | "settings" | "dismissNotice";

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
  const actionCellRef = React.useRef<HTMLDivElement>(null);
  const focusedInActionRef = React.useRef(false);
  const status = query.data;
  const setupKind = status?.setup.kind;

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

  const setup = status.setup;
  const unsupported = setup.kind === "unsupported";
  const busy = botComputerSetupBusy(setup);
  const percent = botComputerSetupPercent(setup);
  const summary = botComputerSetupSummary(setup);
  const offerSetUp = setup.kind === "not_set_up" || setup.kind === "failed";
  const hasAnything = setup.kind !== "not_set_up" || status.diskUsedBytes > 0 || status.computers.length > 0;
  const memory = botComputerMemoryLabel(status.requirements.memoryPerComputerBytes);
  const maxRunningLimit: BotComputerMaxRunning = status.requirements.maxRunningLimit ?? 4;
  const maxRunningChoices = botComputerMaxRunningChoices(maxRunningLimit);
  const displayedMaxRunning = Math.min(status.settings.maxRunning, maxRunningLimit);
  const computerCount = status.computers.length;

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

      {unsupported ? null : (
        <FieldSet title="Running">
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
    </>
  );
}
