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
import { Progress } from "../ui-primitives";
import { botComputersApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { useBotComputersCache, useBotComputersStatus } from "../../lib/use-bot-computers";
import {
  approximateBotComputerBytes,
  BOT_COMPUTER_IDLE_STOP_CHOICES,
  BOT_COMPUTER_MAX_RUNNING_CHOICES,
  botComputerSetupBusy,
  botComputerSetupPercent,
  botComputerSetupSummary,
  formatBotComputerBytes,
  type BotComputersRequirements,
  type BotComputersSettings as BotComputersSettingsValue,
} from "../../shared/bot-computers";

/** Memory as macOS states it: binary gigabytes ("8 GB"). */
export function botComputerMemoryLabel(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024 ** 3))} GB`;
}

/** What Set up downloads, from where and how much space it needs, before the person chooses it. */
export function botComputersSetupDisclosure(requirements: BotComputersRequirements): string {
  return (
    `Set up downloads macOS ${requirements.baseVersion} from Apple (${approximateBotComputerBytes(requirements.downloadBytes)}) ` +
    `and builds a base computer of ${approximateBotComputerBytes(requirements.baseDiskBytes)}. ` +
    `It needs ${approximateBotComputerBytes(requirements.setupFreeBytes)} free while it works, and the download is deleted once the base is ready. ` +
    "Nothing is downloaded until you choose Set up."
  );
}

function idleLabel(minutes: number): string {
  return minutes === 60 ? "1 hour" : `${minutes} minutes`;
}

type Action = "setUp" | "cancel" | "updateBase" | "remove" | "settings";

/**
 * Settings → Bot computers (plan §8): the one place the macOS download and the
 * base computer are set up, sized and removed. Nothing is downloaded until the
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
  const removeEverything = () =>
    run(
      "remove",
      async () => {
        cache.set(await botComputersApi.removeEverything());
        toast.success("Every Bot computer and the macOS download are removed.");
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
  const computerCount = status.computers.length;

  return (
    <>
      <FieldSet title="Setup">
        <Field
          label="Base computer"
          description={
            <>
              <span className="block">{summary}</span>
              {offerSetUp ? <span className="mt-1 block text-tertiary">{botComputersSetupDisclosure(status.requirements)}</span> : null}
              {setup.kind === "ready" ? (
                <span className="mt-1 block text-tertiary">
                  Give a Bot its own computer from the Bot's profile. Each one starts as a copy of the base and grows as the Bot uses it.
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
              <Progress value={percent} label="Downloading macOS" />
            ) : (
              <Progress indeterminate label={summary} />
            )}
          </Field>
        ) : null}
        {/* Announce what setup is doing; the bar carries the percentage. */}
        <span className="sr-only" aria-live="polite">
          {setup.kind === "downloading" ? "Downloading macOS" : summary}
        </span>
      </FieldSet>

      {unsupported ? null : (
        <FieldSet title="Running">
          <Field
            label="Computers running at once"
            description={`Each running computer uses about ${memory} of memory. At the limit, the computer used longest ago stops, or the next Bot waits its turn.`}
          >
            <Select
              value={String(status.settings.maxRunning)}
              disabled={acting === "settings"}
              onValueChange={(value) => changeSettings({ maxRunning: Number(value) === 1 ? 1 : 2 })}
            >
              <SelectTrigger aria-label="Computers running at once" className="max-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BOT_COMPUTER_MAX_RUNNING_CHOICES.map((choice) => (
                  <SelectItem key={choice} value={String(choice)}>
                    {choice === 1 ? "1 computer" : `${choice} computers`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Stop when idle"
            description="A computer nobody has used for this long stops. It starts again when its Bot needs it."
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
            description="Stops and deletes every Bot computer, the base and the macOS download. Files in each Bot's Computer folder stay."
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
        description="Aiden stops and deletes every Bot's computer, the base computer, the macOS download and the keys it uses to reach them. Files in each Bot's Computer folder stay. To use Bot computers again, choose Set up and download macOS again."
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
