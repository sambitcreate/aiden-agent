import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Monitor, RefreshCw, RotateCcw, Square, Trash2 } from "lucide-react";
import {
  AlertDialog,
  Badge,
  Button,
  Field,
  FieldSet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "../../components/ui";
import { botComputersApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { useBots } from "../../lib/queries";
import { useBotComputersCache, useBotComputersStatus } from "../../lib/use-bot-computers";
import type { BotDefinition } from "../../shared/bots";
import {
  BOT_COMPUTER_SHARED_DEFAULT_NAME,
  BOT_COMPUTER_SHARED_ID,
  botComputerSetupSummary,
  botComputerStateLabel,
  type BotComputerAssignTarget,
  type BotComputerStatus,
  type BotComputerVmStatus,
} from "../../shared/bot-computers";

type ComputerBot = Pick<BotDefinition, "id" | "name">;
type Confirm = "reset" | "remove" | null;

const CHOICE_OFF = "__off__";
const CHOICE_NEW = "__new__";

/**
 * The Bot profile's Computer section: assign the Bot to the shared Linux
 * computer, another existing VM, or a new dedicated VM, see what it is doing,
 * and reset or remove it. Renders nothing where the platform has no Bot
 * computers, so unsupported hosts never ask main.
 */
export function BotComputerSection({ bot }: { bot: ComputerBot }) {
  const query = useBotComputersStatus();
  const cache = useBotComputersCache();
  const navigate = useNavigate();
  const [acting, setActing] = React.useState(false);
  const [confirm, setConfirm] = React.useState<Confirm>(null);

  const status = query.supported ? query.data : undefined;
  const computer = status?.computers.find((entry) => entry.botId === bot.id);
  const needsHolderName = Boolean(computer?.activeBotId && computer.activeBotId !== bot.id);
  const botsQuery = useBots(false, needsHolderName);
  const activeBotName = React.useMemo(() => {
    if (!computer?.activeBotId) return undefined;
    return botsQuery.data?.find((entry) => entry.id === computer.activeBotId)?.name;
  }, [botsQuery.data, computer?.activeBotId]);

  if (!query.supported) return null;

  const owner = computer?.shared ? computer.computerName : `${bot.name}'s computer`;
  const vms = status?.vms ?? [];
  const sharedVmName = vms.find((vm) => vm.id === BOT_COMPUTER_SHARED_ID)?.name ?? BOT_COMPUTER_SHARED_DEFAULT_NAME;

  const run = async (operation: () => Promise<void>, failure: string) => {
    setActing(true);
    try {
      await operation();
    } catch (error) {
      toast.error(userFacingErrorMessage(error, failure));
      void cache.refresh();
    } finally {
      setActing(false);
    }
  };
  const give = () =>
    run(async () => {
      cache.putComputer(await botComputersApi.give(bot.id));
      void cache.refresh();
    }, `Aiden couldn't give ${bot.name} a computer.`);
  const assign = (target: BotComputerAssignTarget) =>
    run(async () => {
      cache.putComputer(await botComputersApi.assignComputer(bot.id, target));
      void cache.refresh();
    }, `Aiden couldn't update ${bot.name}'s computer.`);
  const reset = () =>
    run(async () => {
      cache.putComputer(await botComputersApi.reset(bot.id));
      void cache.refresh();
    }, `Aiden couldn't reset ${owner}.`);
  const remove = () =>
    run(async () => {
      await botComputersApi.remove(bot.id);
      cache.dropComputer(bot.id);
      void cache.refresh();
    }, `Aiden couldn't remove ${owner}.`);
  const stop = () => run(() => botComputersApi.stop(bot.id), `Aiden couldn't stop ${owner}.`);
  const openSettings = () => void navigate({ to: "/settings", search: { section: "botComputers" } });

  const handleSelectChange = (value: string) => {
    if (value === CHOICE_OFF) {
      if (computer) setConfirm("remove");
      return;
    }
    if (value === CHOICE_NEW) {
      void assign({ kind: "new" });
      return;
    }
    if (value === BOT_COMPUTER_SHARED_ID) {
      if (computer?.computerId !== BOT_COMPUTER_SHARED_ID) void assign({ kind: "shared" });
      return;
    }
    if (computer?.computerId !== value) void assign({ kind: "existing", computerId: value });
  };

  let row: React.ReactNode;
  if (!status) {
    row = query.isError ? (
      <Field label="Computer" description={`Aiden couldn't check ${bot.name}'s computer.`}>
        <Button size="small" variant="filled" className="justify-self-end" onClick={() => void query.refetch()}>
          <RefreshCw /> Try again
        </Button>
      </Field>
    ) : (
      <div role="status" aria-label={`Checking ${bot.name}'s computer`} className="grid gap-2 p-4">
        <span className="h-3 w-48 max-w-full rounded-full bg-control motion-safe:animate-pulse" />
        <span className="h-2.5 w-24 rounded-full bg-control motion-safe:animate-pulse" />
      </div>
    );
  } else if (status.setup.kind === "unsupported") {
    row = <Field label="Computer" description={botComputerSetupSummary(status.setup)} />;
  } else if (status.setup.kind !== "ready" && !computer) {
    row = (
      <Field
        label="Computer"
        description={
          status.setup.kind === "not_set_up" || status.setup.kind === "failed"
            ? `Set up Bot computers in Settings to give ${bot.name} a Linux computer to work in.`
            : `Bot computers are being set up. ${botComputerSetupSummary(status.setup)}`
        }
      >
        <Button size="small" variant="filled" className="justify-self-end" onClick={openSettings}>
          Open Settings
        </Button>
      </Field>
    );
  } else if (!computer) {
    row = (
      <Field
        label="Computer"
        description={`Give ${bot.name} a Linux computer, apart from yours. It starts when ${bot.name} needs it and stops when idle.`}
      >
        <div className="flex flex-wrap justify-end gap-2">
          <ComputerPicker
            value={CHOICE_OFF}
            sharedVmName={sharedVmName}
            vms={vms}
            disabled={acting}
            onValueChange={handleSelectChange}
          />
          <Button size="small" variant="accent" disabled={acting} onClick={() => void give()}>
            <Monitor /> Give a computer
          </Button>
        </div>
      </Field>
    );
  } else {
    row = (
      <ComputerRow
        bot={bot}
        computer={computer}
        vms={vms}
        sharedVmName={sharedVmName}
        activeBotName={activeBotName}
        acting={acting}
        canSelect={status.setup.kind === "ready"}
        onSelect={handleSelectChange}
        onStop={stop}
        onConfirm={setConfirm}
      />
    );
  }

  return (
    <>
      <FieldSet title="Computer">{row}</FieldSet>
      <AlertDialog
        open={confirm === "reset"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Reset ${owner}?`}
        description={
          computer?.shared
            ? `Aiden deletes everything on ${owner} and clones a fresh copy of the base for every Bot using it. Files in shared and per-Bot folders stay.`
            : `Aiden deletes everything on it and makes a fresh copy of the base. Files in ${bot.name}'s Computer folder stay.`
        }
        confirmLabel="Reset computer"
        confirmVariant="destructive"
        busy={acting}
        onConfirm={() => {
          setConfirm(null);
          void reset();
        }}
      />
      <AlertDialog
        open={confirm === "remove"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={computer?.shared ? `Disconnect ${bot.name} from ${owner}?` : `Remove ${owner}?`}
        description={
          computer?.shared
            ? `${bot.name} will stop using ${owner}, while the shared computer and files in shared and per-Bot folders stay.`
            : `Aiden stops it and deletes it. Files in ${bot.name}'s Computer folder stay, and you can give ${bot.name} a new computer later.`
        }
        confirmLabel="Remove computer"
        confirmVariant="destructive"
        busy={acting}
        onConfirm={() => {
          setConfirm(null);
          void remove();
        }}
      />
    </>
  );
}

function ComputerPicker({
  value,
  currentName,
  sharedVmName,
  vms,
  disabled,
  onValueChange,
}: {
  value: string;
  currentName?: string;
  sharedVmName: string;
  vms: readonly BotComputerVmStatus[];
  disabled: boolean;
  onValueChange: (value: string) => void;
}) {
  const dedicatedVms = vms.filter((vm) => vm.id !== BOT_COMPUTER_SHARED_ID);
  const missingCurrent =
    value !== CHOICE_OFF &&
    value !== BOT_COMPUTER_SHARED_ID &&
    !dedicatedVms.some((vm) => vm.id === value);
  return (
    <Select value={value} disabled={disabled} onValueChange={onValueChange}>
      <SelectTrigger aria-label="Linux computer" className="max-w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={CHOICE_OFF}>Off</SelectItem>
        <SelectItem value={BOT_COMPUTER_SHARED_ID}>{sharedVmName}</SelectItem>
        {dedicatedVms.map((vm) => (
          <SelectItem key={vm.id} value={vm.id}>
            {vm.name}
          </SelectItem>
        ))}
        {missingCurrent ? (
          <SelectItem value={value}>{currentName ?? "Dedicated computer"}</SelectItem>
        ) : null}
        <SelectItem value={CHOICE_NEW}>+ New computer</SelectItem>
      </SelectContent>
    </Select>
  );
}

function ComputerRow({
  bot,
  computer,
  vms,
  sharedVmName,
  activeBotName,
  acting,
  canSelect,
  onSelect,
  onStop,
  onConfirm,
}: {
  bot: ComputerBot;
  computer: BotComputerStatus;
  vms: readonly BotComputerVmStatus[];
  sharedVmName: string;
  activeBotName?: string;
  acting: boolean;
  canSelect: boolean;
  onSelect: (value: string) => void;
  onStop: () => void;
  onConfirm: (confirm: Confirm) => void;
}) {
  const running = computer.state === "running" || computer.state === "starting" || computer.state === "waiting_for_slot";
  const otherHolding = Boolean(computer.activeBotId && computer.activeBotId !== bot.id);
  const queueNotice =
    computer.queuePosition !== undefined
      ? `Waiting for ${activeBotName ?? "another Bot"} on ${computer.computerName} (queue #${computer.queuePosition}).`
      : otherHolding
        ? `${activeBotName ?? "Another Bot"} is currently using ${computer.computerName}.`
        : null;
  return (
    <Field
      label={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span>Computer</span>
          <Badge color={computer.shared ? "blue" : "gray"}>{computer.computerName}</Badge>
        </span>
      }
      description={
        <>
          <span className="block" aria-live="polite">
            {botComputerStateLabel(computer.state, bot.name)}
          </span>
          {queueNotice ? (
            <span className="mt-0.5 block text-status-accent" role="status">
              {queueNotice}
            </span>
          ) : null}
          {computer.activity && computer.state === "running" ? (
            <span className="mt-0.5 block truncate">{computer.activity}</span>
          ) : null}
          {computer.outdated ? (
            <span className="mt-1 block text-tertiary">
              Made from an older base. Reset it to use the new one; resetting erases what's on it.
            </span>
          ) : null}
        </>
      }
    >
      <div className="flex flex-wrap justify-end gap-2">
        {canSelect ? (
          <ComputerPicker
            value={computer.computerId}
            currentName={computer.computerName}
            sharedVmName={sharedVmName}
            vms={vms}
            disabled={acting || computer.state === "stopping"}
            onValueChange={onSelect}
          />
        ) : null}
        {running ? (
          <Button size="small" variant="transparent" disabled={acting || computer.state === "stopping"} onClick={onStop}>
            <Square /> Stop
          </Button>
        ) : null}
        <Button
          size="small"
          variant={computer.state === "stale" || computer.outdated ? "filled" : "transparent"}
          disabled={acting || computer.state === "stopping"}
          onClick={() => onConfirm("reset")}
        >
          <RotateCcw /> Reset
        </Button>
        <Button size="small" variant="transparent" disabled={acting} onClick={() => onConfirm("remove")}>
          <Trash2 /> Remove
        </Button>
      </div>
    </Field>
  );
}
