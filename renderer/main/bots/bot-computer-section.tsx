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
type Confirm = "reset" | "remove" | "stop" | null;
type PendingAssign = {
  target: BotComputerAssignTarget;
  targetName: string;
  otherBotNames: string[];
  leavingDedicatedName?: string;
};

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
  const [pendingAssign, setPendingAssign] = React.useState<PendingAssign | null>(null);

  const status = query.supported ? query.data : undefined;
  const computer = status?.computers.find((entry) => entry.botId === bot.id);
  const vms = status?.vms ?? [];
  const needsBotNames = Boolean(
    (computer?.activeBotId && computer.activeBotId !== bot.id) ||
      vms.some((vm) => vm.assignedBotIds.some((id) => id !== bot.id)),
  );
  const botsQuery = useBots(false, needsBotNames);
  const botNames = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of botsQuery.data ?? []) map.set(entry.id, entry.name);
    return map;
  }, [botsQuery.data]);
  const activeBotName = computer?.activeBotId ? botNames.get(computer.activeBotId) : undefined;

  if (!query.supported) return null;

  const owner = computer?.shared ? computer.computerName : `${bot.name}'s computer`;
  const sharedVmName = vms.find((vm) => vm.id === BOT_COMPUTER_SHARED_ID)?.name ?? BOT_COMPUTER_SHARED_DEFAULT_NAME;
  const assignedVm = computer ? vms.find((vm) => vm.id === computer.computerId) : undefined;
  const otherAssignedIds = (assignedVm?.assignedBotIds ?? []).filter((id) => id !== bot.id);
  const otherAssignedNames = otherAssignedIds.map((id) => botNames.get(id) ?? "another Bot");
  const isSharedWithOthers = Boolean(computer?.shared || otherAssignedIds.length > 0);
  const stopNeedsWarning = Boolean(
    isSharedWithOthers && ((computer?.activeBotId && computer.activeBotId !== bot.id) || otherAssignedIds.length > 0),
  );

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
  const assign = (target: BotComputerAssignTarget, leavingDedicatedName?: string) =>
    run(async () => {
      cache.putComputer(await botComputersApi.assignComputer(bot.id, target));
      if (leavingDedicatedName) {
        toast.info(`${leavingDedicatedName} stays in Settings → Computers until you delete it there.`);
      }
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
    const leavingDedicatedName =
      computer && !computer.shared && otherAssignedIds.length === 0 ? computer.computerName : undefined;
    if (value === CHOICE_NEW) {
      void assign({ kind: "new" }, leavingDedicatedName);
      return;
    }
    if (computer?.computerId === value) return;
    const target: BotComputerAssignTarget =
      value === BOT_COMPUTER_SHARED_ID ? { kind: "shared" } : { kind: "existing", computerId: value };
    const targetVm = vms.find((vm) => vm.id === value);
    const targetOtherIds = (targetVm?.assignedBotIds ?? []).filter((id) => id !== bot.id);
    if (targetOtherIds.length > 0) {
      setPendingAssign({
        target,
        targetName: targetVm?.name ?? sharedVmName,
        otherBotNames: targetOtherIds.map((id) => botNames.get(id) ?? "another Bot"),
        leavingDedicatedName,
      });
      return;
    }
    void assign(target, leavingDedicatedName);
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
        isSharedWithOthers={isSharedWithOthers}
        acting={acting}
        canSelect={status.setup.kind === "ready"}
        onSelect={handleSelectChange}
        onStop={() => {
          if (stopNeedsWarning) setConfirm("stop");
          else void stop();
        }}
        onConfirm={setConfirm}
      />
    );
  }

  return (
    <>
      <FieldSet title="Computer">{row}</FieldSet>
      <AlertDialog
        open={confirm === "stop"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Stop ${computer?.computerName ?? owner}?`}
        description={
          computer?.activeBotId && computer.activeBotId !== bot.id
            ? `${activeBotName ?? "Another Bot"} is currently using ${computer.computerName}. Stopping it interrupts active work for every Bot assigned to it.`
            : `${otherAssignedNames.join(", ")} also use ${computer?.computerName ?? owner}. Stopping it turns off the computer for every Bot assigned to it.`
        }
        confirmLabel="Stop computer"
        confirmVariant="destructive"
        busy={acting}
        onConfirm={() => {
          setConfirm(null);
          void stop();
        }}
      />
      <AlertDialog
        open={pendingAssign !== null}
        onOpenChange={(open) => !open && setPendingAssign(null)}
        title={pendingAssign ? `Use ${pendingAssign.targetName} for ${bot.name}?` : "Switch computer?"}
        description={
          pendingAssign
            ? `${pendingAssign.targetName} is already used by ${pendingAssign.otherBotNames.join(", ")}. Bots on the same computer share one Linux desktop, user (aiden-bot), and Chromium sign-ins, with separate working folders (~/bots/<dir>) beside ~/Shared.${
                pendingAssign.leavingDedicatedName
                  ? ` ${pendingAssign.leavingDedicatedName} will stay in Settings → Computers until you delete it there.`
                  : ""
              }`
            : undefined
        }
        confirmLabel="Switch computer"
        busy={acting}
        onConfirm={() => {
          const next = pendingAssign;
          setPendingAssign(null);
          if (next) void assign(next.target, next.leavingDedicatedName);
        }}
      />
      <AlertDialog
        open={confirm === "reset"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Reset ${owner}?`}
        description={
          `${
            computer?.activeBotId
              ? `In use by ${activeBotName ?? bot.name}. Resetting interrupts active work. `
              : ""
          }${
            isSharedWithOthers
              ? `Aiden deletes everything on ${owner} and clones a fresh copy of the base for every Bot using it. Files in the computer's shared and per-Bot folders stay.`
              : computer?.computerId.startsWith("aiden-bot-")
                ? `Aiden deletes everything on it and makes a fresh copy of the base. Files in ${bot.name}'s Computer folder stay.`
                : `Aiden deletes everything on it and makes a fresh copy of the base. Files in this computer's mounted folder stay.`
          }`
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
        title={isSharedWithOthers ? `Disconnect ${bot.name} from ${owner}?` : `Remove ${owner}?`}
        description={
          isSharedWithOthers
            ? `${bot.name} will stop using ${owner}, while ${owner} stays for other Bots. ${bot.name}'s per-Bot folder on ${owner} is removed (its own Computer folder stays).`
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
  isSharedWithOthers,
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
  isSharedWithOthers: boolean;
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
          {isSharedWithOthers ? (
            <span className="mt-1 block text-tertiary">
              Bots on {computer.computerName} share one Linux desktop, user (aiden-bot), and Chromium sign-ins, with separate working folders beside ~/Shared.
            </span>
          ) : canSelect ? (
            <span className="mt-1 block text-tertiary">
              Switching to another computer keeps this VM in Settings → Computers until you delete it there.
            </span>
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
          disabled={acting || computer.state === "starting" || computer.state === "stopping"}
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
