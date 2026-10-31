/**
 * The Bot-computers contract (blueprint §2.11). P8 implements the host, the
 * control lock and the session registry; P9 plugs a screen factory into
 * `BotComputerSessions.setScreenFactory`, and P10 and P11 consume `host`,
 * `control` and `sessions` without reaching into their implementations.
 */

import type { CuaDriverHostFactory } from "../computer-use/controller.js";
import type {
  BotComputerSetupState,
  BotComputersSettings,
  BotComputersStatus,
  BotComputerStatus,
} from "../../../renderer/shared/bot-computers.js";

export type {
  BotComputerRunState,
  BotComputerSetupState,
  BotComputersSettings,
  BotComputersStatus,
  BotComputerStatus,
} from "../../../renderer/shared/bot-computers.js";

export interface BotComputerConnection {
  vmName: string;
  ip: string;
  vnc: { host: "127.0.0.1"; port: number; password: string };
  ssh: { host: string; user: "lume" };
}

export type BotComputerStartReason = "tool" | "routine" | "viewer";
export type BotComputerStopReason = "idle" | "pause" | "person" | "quit" | "limit";

export interface BotComputerGuestCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface BotComputerHost {
  status(): Promise<BotComputersStatus>;
  /**
   * Whether a base is set up, so Bots' computers can run: a store read with no
   * disk walk. Stays true while Update base builds a new base beside it.
   */
  baseReady(): Promise<boolean>;
  computer(botId: string): Promise<BotComputerStatus | undefined>;
  setUp(): Promise<void>;
  cancelSetUp(): void;
  updateBase(): Promise<void>;
  removeEverything(): Promise<void>;
  updateSettings(settings: Partial<BotComputersSettings>): Promise<BotComputersSettings>;
  /**
   * Give, Reset and Delete of one Bot's computer run one at a time, in the order they were
   * called; Remove everything waits for those called before it, and those called after wait for it.
   */
  give(botId: string): Promise<BotComputerStatus>;
  reset(botId: string): Promise<BotComputerStatus>;
  /** Idempotent: a Bot with no computer, or a VM Lume no longer has, counts as success. */
  deleteForBot(botId: string): Promise<void>;
  ensureRunning(
    botId: string,
    options: { reason: BotComputerStartReason; signal?: AbortSignal; onProgress?(text: string): void },
  ): Promise<BotComputerConnection>;
  /**
   * Stops the computer. A start in progress is cancelled, and this waits until what it launched
   * is off: Lume's `run` returning, then up to the launch settle time (10 s) for a VM that is
   * still coming up. When even a forced stop fails and Lume still reports the VM running,
   * it stays running (with its place, and its connection if it had one) and this rejects. A
   * stop that turns it off gives control back to the Bot, except while a sign-in card holds it
   * for the person.
   */
  stop(botId: string, options?: { reason: BotComputerStopReason }): Promise<void>;
  /** This run's connection while the computer is running, or undefined; never starts it. */
  runningConnection(botId: string): BotComputerConnection | undefined;
  /** Restart the idle timer after the Bot or the person used the computer. */
  touch(botId: string): void;
  runGuestCommand(
    botId: string,
    command: string,
    options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
  ): Promise<BotComputerGuestCommandResult>;
  /**
   * The guest driver lane (plan §8.6) for this Bot's computer: a host factory
   * for `ComputerUseController`, only when the computer was made from a base
   * whose guest driver passed its probe for the pinned version.
   */
  guestDriver(botId: string): Promise<CuaDriverHostFactory | undefined>;
  /** Element control on a ready base without it: boots the base, installs the driver, waits for the grants. */
  setUpElementControl(): Promise<void>;
  /** While setup waits for the grants: check them now, or finish without element control. */
  checkPermissions(): void;
  skipPermissions(): void;
  /** The base computer while setup waits for the person's grants (Settings shows its screen). */
  baseView(): BotComputerConnection | undefined;
  reconcile(): Promise<void>;
  /**
   * Quit's first step, before anything waits: refuse new starts and end any `lume run` still
   * launching, at once. `shutdown` does this too.
   */
  beginQuit(): void;
  shutdown(timeoutMs: number): Promise<void>;
  onChange(listener: (botId: string | undefined) => void): () => void;
}

export interface BotComputerCapture {
  image: Buffer;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  framebufferWidth: number;
  framebufferHeight: number;
}

export interface BotComputerScreen {
  capture(options: {
    format: "png" | "jpeg";
    maxWidth: number;
    quality?: number;
    signal?: AbortSignal;
  }): Promise<BotComputerCapture>;
  /** Framebuffer pixels; `buttons` is the RFB button bitmask. */
  pointer(event: { x: number; y: number; buttons: number }, signal?: AbortSignal): Promise<void>;
  key(event: { keysym: number; down: boolean }, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export type BotComputerScreenFactory = (
  connection: BotComputerConnection,
  signal?: AbortSignal,
) => Promise<BotComputerScreen>;

/** The person took over the Bot's computer; the Bot's action was interrupted. */
export class BotComputerTakenOverError extends Error {
  constructor(message = "The person took over the computer.") {
    super(message);
    this.name = "BotComputerTakenOverError";
  }
}

export type BotComputerTakeOverSource = "viewer" | "input" | "sign_in";

export interface BotComputerControl {
  controller(botId: string): "bot" | "person";
  /** Aborts the Bot's in-flight action. */
  takeOver(botId: string, by: BotComputerTakeOverSource): void;
  giveBack(botId: string): void;
  /** Throws `BotComputerTakenOverError` while, or once, the person has control. */
  run<T>(botId: string, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T>;
  waitForBot(botId: string, signal: AbortSignal | undefined): Promise<void>;
  onChange(listener: (botId: string) => void): () => void;
}

export interface BotComputerPointer {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BotComputerSessions {
  /** `ensureRunning` plus the screen factory; one screen is cached per run. */
  screen(botId: string, signal?: AbortSignal): Promise<BotComputerScreen>;
  /** The running computer's screen (the viewer's); refuses a computer that isn't running and never starts one. */
  runningScreen(botId: string, signal?: AbortSignal): Promise<BotComputerScreen>;
  /** Set once by P9's viewer. */
  setScreenFactory(factory: BotComputerScreenFactory): void;
  control: BotComputerControl;
  recordPointer(botId: string, pointer: BotComputerPointer): void;
  lastPointer(botId: string): BotComputerPointer | undefined;
  setActivity(botId: string, text: string | undefined): void;
}

/** P10's tool names, fixed here so policy and the catalog agree. */
export const BOT_COMPUTER_TOOL_NAME = "computer";
export const BOT_COMPUTER_SHELL_TOOL_NAME = "computer_shell";

/** Host secret holding the rotated guest password (§2.11). */
export const BOT_COMPUTER_SECRET_FAMILY = "aiden-internal:bot-computers";
export const BOT_COMPUTER_GUEST_PASSWORD_SECRET = `${BOT_COMPUTER_SECRET_FAMILY}:guest-password`;

/** A Bot-computer failure with a message fit to show the person. */
export class BotComputerError extends Error {
  constructor(
    readonly code:
      | "unsupported"
      | "not_set_up"
      | "no_computer"
      | "busy"
      | "cancelled"
      | "low_disk"
      | "low_memory"
      | "vm_limit"
      | "vnc_not_loopback"
      | "start_failed"
      | "stale"
      | "lume_failed"
      | "download_failed"
      | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "BotComputerError";
  }
}

export type BotComputerSetupKind = BotComputerSetupState["kind"];
