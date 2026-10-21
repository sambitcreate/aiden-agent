// A Bot's own computer in its side panel (plan §8.5): the live screen with
// the Bot's avatar at its last action point, the status line, Take over and
// Give back, and Float over chat. The screen is the Simulator's device stream
// (`useDeviceStream` over `createDeviceStreamClient`, MJPEG), served by main's
// Bot computer viewer hub; the VNC password and socket never leave main.
//
// - The computer starts only when the person switches to this tab or presses
//   Start; a tab restored at launch shows Start instead.
// - While the Bot drives, the screen is read-only: the person's first click,
//   key or scroll takes over (main interrupts the Bot's action) and does not
//   itself reach the computer. Take over does the same without touching it.
// - Command shortcuts and Tab stay with Aiden, so keyboard users can always
//   leave the screen.

import * as React from "react";
import { MousePointerClick, PictureInPicture2, Play, RefreshCw, Undo2 } from "lucide-react";
import { AidenActivityMark } from "../../components/aiden-activity-mark";
import { BotAvatar } from "../../components/bot-avatar";
import { DeviceFloatingPlaceholder } from "../../components/device-floating-placeholder";
import { useDocumentVisible } from "../../components/device-mini-player";
import { Button, Text, toast } from "../../components/ui";
import { DEVICE_SCREEN_CONTAINER_STYLE, fittedScreenStyle } from "../../lib/device-display-rotation";
import { botComputersApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { useBotComputersCache, useBotComputersStatus } from "../../lib/use-bot-computers";
import { useBotLive } from "../../lib/use-bot-live";
import { useDeviceScreenWheel } from "../../lib/use-device-screen-wheel";
import { useDeviceStream } from "../../lib/use-device-stream";
import { cn } from "../../lib/ui-utils";
import {
  BOT_COMPUTER_VIEWER_HOST_ID,
  botComputerStateLabel,
  type BotComputerPointer,
  type BotComputerStatus,
} from "../../shared/bot-computers";
import type { BotDefinition } from "../../shared/bots";

export type ComputerBot = Pick<BotDefinition, "id" | "name" | "avatar">;

/** How often the Bot's last action point is read while it drives a computer on screen. */
export const BOT_COMPUTER_POINTER_POLL_MS = 500;

/** The Bot's computer, where this Mac has Bot computers. */
export function useBotComputer(botId: string) {
  const query = useBotComputersStatus();
  const computer = query.data?.computers.find((entry) => entry.botId === botId);
  return { supported: query.supported, loaded: query.data !== undefined, failed: query.isError, computer };
}

/** The Bot's last action point, read only while it drives a running computer the person can see. */
function useBotPointer(botId: string, enabled: boolean): BotComputerPointer | null {
  const [pointer, setPointer] = React.useState<BotComputerPointer | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    let current = true;
    const read = () =>
      void botComputersApi.pointer(botId).then(
        (next) => {
          if (!current) return;
          setPointer((previous) =>
            previous && next && previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height
              ? previous
              : next,
          );
        },
        () => undefined,
      );
    read();
    const timer = window.setInterval(read, BOT_COMPUTER_POINTER_POLL_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [botId, enabled]);
  return enabled ? pointer : null;
}

export interface BotComputerStart {
  pending: boolean;
  error: string | null;
  start(): void;
}

/** Starting the computer for the person: the viewer grant with `start`, and what went wrong. */
export function useBotComputerStart(bot: Pick<ComputerBot, "id" | "name">): BotComputerStart {
  const cache = useBotComputersCache();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const start = React.useCallback(() => {
    setPending(true);
    setError(null);
    botComputersApi
      .viewerGrant(bot.id, { start: true })
      .then(
        () => undefined,
        (failure: unknown) => {
          if (mounted.current) setError(userFacingErrorMessage(failure, `Aiden couldn't start ${bot.name}'s computer.`));
        },
      )
      .finally(() => {
        if (mounted.current) setPending(false);
        void cache.refresh();
      });
  }, [bot.id, bot.name, cache]);
  return { pending, error, start };
}

/**
 * A sign-in on the Bot's own computer (plan §8.8) that the person now holds
 * brings the Computer tab forward, once per card, without moving focus. This
 * is how the Mac's window shows the computer after Finish on your Mac on a
 * phone, where nobody pressed Open here; an Open on this Mac shows the tab
 * itself (`use-bot-handoff-actions.ts`). A remembered view shown while the
 * chat reopens is not enough: that card may have been answered since, so only
 * the fresh snapshot moves the panel. Renders nothing.
 */
export function BotComputerSignInReveal({
  botId,
  controller,
  onReveal,
}: {
  botId: string;
  /** Who drives the Bot's computer now, or undefined when it has none. */
  controller: BotComputerStatus["controller"] | undefined;
  onReveal(): void;
}) {
  const live = useBotLive(botId);
  const handoff = live.stale ? null : (live.snapshot?.handoff ?? null);
  const waitId = handoff?.kind === "sign_in" && handoff.target === "computer" ? handoff.waitId : null;
  const revealed = React.useRef<string | null>(null);
  const onRevealRef = React.useRef(onReveal);
  onRevealRef.current = onReveal;
  React.useEffect(() => {
    if (waitId === null || controller !== "person" || revealed.current === waitId) return;
    revealed.current = waitId;
    onRevealRef.current();
  }, [waitId, controller]);
  return null;
}

/** Take over and Give back, keeping the cached status in step with main's reply. */
export function useBotComputerControl(bot: Pick<ComputerBot, "id" | "name">) {
  const cache = useBotComputersCache();
  const [busy, setBusy] = React.useState(false);
  const act = React.useCallback(
    (operation: () => Promise<BotComputerStatus>, failure: string) => {
      setBusy(true);
      operation()
        .then(cache.putComputer, (error: unknown) => {
          toast.error(userFacingErrorMessage(error, failure));
          void cache.refresh();
        })
        .finally(() => setBusy(false));
    },
    [cache],
  );
  return {
    busy,
    takeOver: () => act(() => botComputersApi.takeOver(bot.id), `Aiden couldn't take over ${bot.name}'s computer.`),
    giveBack: () => act(() => botComputersApi.giveBack(bot.id), `Aiden couldn't give ${bot.name}'s computer back.`),
  };
}

/** A Mac screen's shape until the first frame says otherwise. */
export const BOT_COMPUTER_DEFAULT_SCREEN = { width: 1440, height: 900 } as const;

interface ComputerScreenProps {
  bot: ComputerBot;
  computer: BotComputerStatus;
  active: boolean;
  variant: "tab" | "float";
  /** The framebuffer's size once the stream reports it, for a frame that keeps its shape. */
  onScreen?(screen: { width: number; height: number } | null): void;
}

/** The live screen of a running computer: stream, avatar, read-only hint, and the person's input. */
function ComputerScreen({ bot, computer, active, variant, onScreen }: ComputerScreenProps) {
  const requestGrant = React.useCallback(async () => (await botComputersApi.viewerGrant(bot.id, { start: false })).grant, [bot.id]);
  const stream = useDeviceStream({
    hostId: BOT_COMPUTER_VIEWER_HOST_ID,
    deviceId: computer.vmName,
    platform: "ios",
    active,
    preferMjpeg: true,
    requestGrant,
  });
  const botDrives = computer.controller === "bot";
  const pointer = useBotPointer(bot.id, active && botDrives);
  const screenRef = React.useRef<HTMLDivElement | null>(null);
  const owner = `${bot.name}'s computer`;
  const screenSize = stream.screen && stream.screen.width > 0 && stream.screen.height > 0 ? stream.screen : null;
  const aspect = (screenSize ?? BOT_COMPUTER_DEFAULT_SCREEN).width / (screenSize ?? BOT_COMPUTER_DEFAULT_SCREEN).height;
  const onScreenRef = React.useRef(onScreen);
  onScreenRef.current = onScreen;
  const screenWidth = screenSize?.width ?? 0;
  const screenHeight = screenSize?.height ?? 0;
  React.useEffect(() => {
    onScreenRef.current?.(screenWidth > 0 ? { width: screenWidth, height: screenHeight } : null);
  }, [screenWidth, screenHeight]);

  // Wheel events scroll the computer, not the panel.
  useDeviceScreenWheel(screenRef, stream.client);

  const streaming = stream.status === "streaming";
  // The avatar and the read-only hint show while connecting too; a lost stream covers them with Reconnect.
  const overlays = stream.status !== "error";
  return (
    <div
      className={cn("relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-well", variant === "float" ? "rounded-b-sheet" : "p-3")}
      style={DEVICE_SCREEN_CONTAINER_STYLE}
    >
      <div
        ref={screenRef}
        className={cn("device-viewer-screen bot-computer-screen", variant === "float" && "device-mini-player-screen")}
        data-typing-surface="device"
        data-bot-computer-screen={computer.vmName}
        data-controller={computer.controller}
        style={{ ...DEVICE_SCREEN_CONTAINER_STYLE, ...fittedScreenStyle(aspect) }}
        tabIndex={0}
        role="application"
        aria-roledescription="computer screen"
        aria-label={
          botDrives
            ? `${owner} screen. ${bot.name} is using it; click or type here to take over.`
            : `${owner} screen. Click or drag to use the mouse; type to send keys while focused.`
        }
        onPointerDown={stream.pointer("begin")}
        onPointerMove={stream.pointer("move")}
        onPointerUp={stream.pointer("end")}
        onPointerCancel={stream.pointer("end")}
        onKeyDown={stream.key("down")}
        onKeyUp={stream.key("up")}
        onBlur={stream.releaseKeys}
        onContextMenu={(event) => event.preventDefault()}
      >
        <canvas ref={stream.canvasRef} hidden={Boolean(stream.mjpegUrl)} aria-hidden />
        {stream.mjpegUrl ? <img ref={stream.attachImage} alt="" draggable={false} /> : null}
        {pointer && overlays ? (
          <span
            aria-hidden="true"
            data-bot-computer-pointer
            className="bot-computer-pointer"
            style={{ left: `${(pointer.x / pointer.width) * 100}%`, top: `${(pointer.y / pointer.height) * 100}%` }}
          >
            <BotAvatar botId={bot.id} avatar={bot.avatar} name={bot.name} photoLoading="immediate" size="small" working={Boolean(computer.activity)} />
          </span>
        ) : null}
        {botDrives && overlays ? (
          <span className="device-viewer-notice" data-bot-computer-read-only>
            {bot.name} is using it · Click or type to take over
          </span>
        ) : null}
        {stream.status === "error" ? (
          <div className="device-viewer-overlay">
            <Text variant="small" color="secondary">
              {owner}'s screen stopped updating.
            </Text>
            <Button size="small" variant="muted" onClick={stream.reconnect}>
              <RefreshCw aria-hidden /> Reconnect
            </Button>
          </div>
        ) : null}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {streaming ? (botDrives ? `${bot.name} is using ${owner}` : `You're using ${owner}`) : stream.status === "error" ? "Disconnected" : "Connecting…"}
      </span>
    </div>
  );
}

/** Everything but the live screen: off, starting, waiting, stopping, unfinished. */
function ComputerState({ bot, computer, start }: { bot: ComputerBot; computer: BotComputerStatus; start: BotComputerStart }) {
  const starting = start.pending || computer.state === "starting" || computer.state === "waiting_for_slot";
  if (starting || computer.state === "stopping") {
    const label =
      computer.state === "stopping" || computer.state === "waiting_for_slot" ? botComputerStateLabel(computer.state, bot.name) : `Starting ${bot.name}'s computer…`;
    return (
      <div role="status" className="browser-empty h-full min-h-0" data-bot-computer-banner>
        <AidenActivityMark mark="bounce" size={24} className="text-primary" />
        <Text variant="strong">{label}</Text>
      </div>
    );
  }
  return (
    <section aria-labelledby={`bot-computer-${bot.id}-state`} className="browser-empty h-full min-h-0">
      <Text id={`bot-computer-${bot.id}-state`} variant="strong">
        {computer.state === "stale" ? `${bot.name}'s computer didn't finish being made` : `${bot.name}'s computer is off`}
      </Text>
      <p>
        {computer.state === "stale"
          ? "Reset it in the Bot's profile to start again."
          : `It starts when ${bot.name} needs it, or when you start it here.`}
      </p>
      {start.error ? (
        <p role="alert">
          {start.error}
        </p>
      ) : null}
      {computer.state === "stale" ? null : (
        <Button size="small" variant="filled" onClick={start.start}>
          <Play aria-hidden /> {start.error ? "Try again" : "Start"}
        </Button>
      )}
    </section>
  );
}

/** The screen or its state; the tab and the floating player both show this. */
export function BotComputerView({
  bot,
  computer,
  active,
  variant,
  start,
  onScreen,
}: {
  bot: ComputerBot;
  computer: BotComputerStatus;
  active: boolean;
  variant: "tab" | "float";
  start: BotComputerStart;
  onScreen?(screen: { width: number; height: number } | null): void;
}) {
  if (computer.state === "running" && !start.pending) {
    return <ComputerScreen bot={bot} computer={computer} active={active} variant={variant} onScreen={onScreen} />;
  }
  return variant === "float" ? (
    <div className="min-h-0 flex-1 overflow-auto rounded-b-sheet bg-well">
      <ComputerState bot={bot} computer={computer} start={start} />
    </div>
  ) : (
    <ComputerState bot={bot} computer={computer} start={start} />
  );
}

/** Take over or Give back, whichever applies. */
export function BotComputerControlButton({
  bot,
  computer,
  variant = "tab",
}: {
  bot: ComputerBot;
  computer: BotComputerStatus;
  variant?: "tab" | "float";
}) {
  const control = useBotComputerControl(bot);
  if (computer.state !== "running") return null;
  const botDrives = computer.controller === "bot";
  const label = botDrives ? "Take over" : `Give back to ${bot.name}`;
  return variant === "float" ? (
    <Button variant="transparent" size="small" iconOnly aria-label={label} title={label} disabled={control.busy} onClick={botDrives ? control.takeOver : control.giveBack}>
      {botDrives ? <MousePointerClick aria-hidden /> : <Undo2 aria-hidden />}
    </Button>
  ) : (
    <Button variant={botDrives ? "filled" : "accent"} size="small" disabled={control.busy} onClick={botDrives ? control.takeOver : control.giveBack}>
      {botDrives ? <MousePointerClick aria-hidden /> : <Undo2 aria-hidden />}
      {botDrives ? "Take over" : "Give back"}
    </Button>
  );
}

/** The status line: what the Bot is doing, or that the person has the computer. */
function ComputerStatusLine({ bot, computer }: { bot: ComputerBot; computer: BotComputerStatus }) {
  if (computer.state !== "running") return null;
  if (computer.controller === "person") {
    return (
      <Text variant="small" color="secondary" className="min-w-0 flex-1 truncate">
        You're using {bot.name}'s computer
      </Text>
    );
  }
  const text = computer.activity ?? `${bot.name}'s computer is running`;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2" data-bot-computer-activity>
      <AidenActivityMark mark="quad-shuffle" size={16} active={Boolean(computer.activity)} className="shrink-0 text-primary" />
      <Text variant="small" color="secondary" className="min-w-0 truncate">
        {text}
      </Text>
    </span>
  );
}

/**
 * The Computer tab's body. Switching to the tab starts a stopped computer
 * (the workbench calls `start`); a tab restored at launch shows Start
 * instead. While the computer floats over the chat, the tab says so instead
 * of streaming a second copy.
 */
export function BotComputerTab({
  bot,
  computer,
  active,
  floating,
  onFloat,
  onDock,
  start,
}: {
  bot: ComputerBot;
  computer: BotComputerStatus;
  active: boolean;
  floating: boolean;
  onFloat(): void;
  onDock(): void;
  start: BotComputerStart;
}) {
  const visible = useDocumentVisible();
  if (floating) return <DeviceFloatingPlaceholder name={`${bot.name}'s computer`} onDock={onDock} />;
  return (
    <div className="flex h-full min-h-0 flex-col" data-bot-computer-tab={bot.id}>
      {computer.state === "running" ? (
        <div className="flex min-h-10 shrink-0 items-center gap-2 px-3 py-1.5">
          <ComputerStatusLine bot={bot} computer={computer} />
          <BotComputerControlButton bot={bot} computer={computer} />
          <Button variant="transparent" size="small" iconOnly aria-label="Float over chat" title="Float over chat" onClick={onFloat}>
            <PictureInPicture2 aria-hidden />
          </Button>
        </div>
      ) : null}
      <BotComputerView bot={bot} computer={computer} active={active && visible} variant="tab" start={start} />
    </div>
  );
}
