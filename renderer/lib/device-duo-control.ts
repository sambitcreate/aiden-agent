/**
 * Adapted from t3code packages/client-runtime/src/device/duoControl.ts @ 1c127066 (MIT)
 *
 * iPhone Duo hinge and orientation commands travel over the helper's input
 * socket, one native transaction at a time. The helper acknowledges each
 * request by id (tag 0x90), or, for orientation, by pushing a new screen config.
 * T3's pinch accumulator drives its 3D viewer and waits for Phase 6.
 */
export const DUO_POSES = [
  { id: "closed", label: "Closed", angle: 0 },
  { id: "book", label: "Book", angle: 90 },
  { id: "open", label: "Open", angle: 180 },
  { id: "laptop", label: "Laptop", angle: 90 },
  { id: "tent", label: "Tent", angle: 80 },
] as const;
export type DuoPose = (typeof DUO_POSES)[number]["id"];
export const DUO_POSE_IDS: readonly DuoPose[] = DUO_POSES.map((pose) => pose.id);
export type DuoOrientation = "portrait" | "landscape_left" | "portrait_upside_down" | "landscape_right";
export type DuoCommand =
  | { control: "angle"; value: number }
  | { control: "pose"; value: DuoPose }
  | { control: "table"; value: boolean }
  | { control: "physical"; value: "faceup" | "facedown" }
  | { control: "orientation"; value: DuoOrientation };
export interface DuoControlState {
  pending: boolean;
  requested: DuoCommand | null;
  error: string | null;
}
export interface DuoControlReply {
  requestId: number;
  ok: boolean;
  error?: string;
}
export interface DuoControl {
  enqueue(command: DuoCommand): void;
  receive(reply: DuoControlReply): void;
  clear(error?: string | null): void;
}

export const DUO_CONTROL_TIMEOUT_MS = 5_000;

/** One in-flight native transaction. Hinge motion coalesces; presets replace queued motion. Nothing replays after reconnect. */
export function createDuoControl(options: {
  send: (request: { requestId: number; command: DuoCommand }) => boolean;
  onChange: (state: DuoControlState) => void;
  timeoutMs?: number;
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}): DuoControl {
  const schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  let nextId = 1;
  let active: { requestId: number; command: DuoCommand } | null = null;
  let queued: DuoCommand | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const publish = (error: string | null = null) =>
    options.onChange({ pending: Boolean(active), requested: queued ?? active?.command ?? null, error });
  const clear = (error: string | null = null) => {
    if (timer !== null) cancel(timer);
    timer = null;
    active = null;
    queued = null;
    publish(error);
  };
  const drain = () => {
    if (active || !queued) return;
    active = { requestId: nextId++, command: queued };
    queued = null;
    const id = active.requestId;
    timer = schedule(() => {
      if (active?.requestId === id) clear("Device control timed out. Its position is unknown.");
    }, options.timeoutMs ?? DUO_CONTROL_TIMEOUT_MS);
    publish();
    if (!options.send(active)) clear("Device is disconnected.");
  };
  return {
    enqueue(command) {
      if (command.control === "angle" && (!Number.isFinite(command.value) || command.value < 0 || command.value > 180)) {
        return;
      }
      queued = command;
      if (active) publish();
      else drain();
    },
    receive(reply) {
      if (!active || reply.requestId !== active.requestId) return;
      if (timer !== null) cancel(timer);
      timer = null;
      active = null;
      if (!reply.ok) {
        clear(reply.error ?? "Device control failed. Its position is unknown.");
        return;
      }
      if (queued) drain();
      else publish();
    },
    clear,
  };
}
