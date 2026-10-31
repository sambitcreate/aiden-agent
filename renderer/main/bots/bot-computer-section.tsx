import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Monitor, RefreshCw, RotateCcw, Square, Trash2 } from "lucide-react";
import { AlertDialog, Button, Field, FieldSet, toast } from "../../components/ui";
import { botComputersApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { useBotComputersCache, useBotComputersStatus } from "../../lib/use-bot-computers";
import type { BotDefinition } from "../../shared/bots";
import { botComputerSetupSummary, botComputerStateLabel, type BotComputerStatus } from "../../shared/bot-computers";

type ComputerBot = Pick<BotDefinition, "id" | "name">;
type Confirm = "reset" | "remove" | null;

/**
 * The Bot profile's Computer section (plan §8): give the Bot its own macOS
 * computer, see what it is doing, and reset or remove it. Renders nothing
 * where the platform has no Bot computers, so Linux never asks main.
 */
export function BotComputerSection({ bot }: { bot: ComputerBot }) {
  const query = useBotComputersStatus();
  const cache = useBotComputersCache();
  const navigate = useNavigate();
  const [acting, setActing] = React.useState(false);
  const [confirm, setConfirm] = React.useState<Confirm>(null);
  if (!query.supported) return null;

  const status = query.data;
  const computer = status?.computers.find((entry) => entry.botId === bot.id);
  const owner = `${bot.name}'s computer`;

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
  const give = () => run(async () => cache.putComputer(await botComputersApi.give(bot.id)), `Aiden couldn't give ${bot.name} a computer.`);
  const reset = () => run(async () => cache.putComputer(await botComputersApi.reset(bot.id)), `Aiden couldn't reset ${owner}.`);
  const remove = () =>
    run(async () => {
      await botComputersApi.remove(bot.id);
      cache.dropComputer(bot.id);
    }, `Aiden couldn't remove ${owner}.`);
  const stop = () => run(() => botComputersApi.stop(bot.id), `Aiden couldn't stop ${owner}.`);
  const openSettings = () => void navigate({ to: "/settings", search: { section: "botComputers" } });

  let row: React.ReactNode;
  if (!status) {
    row = query.isError ? (
      <Field label="Computer" description={`Aiden couldn't check ${owner}.`}>
        <Button size="small" variant="filled" className="justify-self-end" onClick={() => void query.refetch()}>
          <RefreshCw /> Try again
        </Button>
      </Field>
    ) : (
      <div role="status" aria-label={`Checking ${owner}`} className="grid gap-2 p-4">
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
            ? `Set up Bot computers in Settings to give ${bot.name} its own macOS computer to work in.`
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
        description={`Give ${bot.name} its own macOS computer, apart from yours. It starts when ${bot.name} needs it and stops when idle.`}
      >
        <Button size="small" variant="accent" className="justify-self-end" disabled={acting} onClick={() => void give()}>
          <Monitor /> Give a computer
        </Button>
      </Field>
    );
  } else {
    row = <ComputerRow bot={bot} computer={computer} acting={acting} onStop={stop} onConfirm={setConfirm} />;
  }

  return (
    <>
      <FieldSet title="Computer">{row}</FieldSet>
      <AlertDialog
        open={confirm === "reset"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Reset ${owner}?`}
        description={`Aiden deletes everything on it and makes a fresh copy of the base. Files in ${bot.name}'s Computer folder stay.`}
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
        title={`Remove ${owner}?`}
        description={`Aiden stops it and deletes it. Files in ${bot.name}'s Computer folder stay, and you can give ${bot.name} a new computer later.`}
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

function ComputerRow({
  bot,
  computer,
  acting,
  onStop,
  onConfirm,
}: {
  bot: ComputerBot;
  computer: BotComputerStatus;
  acting: boolean;
  onStop: () => void;
  onConfirm: (confirm: Confirm) => void;
}) {
  const running = computer.state === "running" || computer.state === "starting" || computer.state === "waiting_for_slot";
  return (
    <Field
      label="Computer"
      description={
        <>
          <span className="block" aria-live="polite">
            {botComputerStateLabel(computer.state, bot.name)}
          </span>
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
