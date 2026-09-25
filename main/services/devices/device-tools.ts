/**
 * Adapted from t3code apps/server/src/mcp/toolkits/device/handlers.ts and
 * tools.ts @ 1c127066 (MIT)
 *
 * A deliberately small surface: lifecycle, visibility for the user, and one
 * image-returning verb. Driving the device (taps, typing, installs, logs)
 * happens through the pinned `agent-device` CLI, which the agent runs from its
 * shell with the flags `device_open` returns.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  LOCAL_DEVICE_HOST_ID,
  type DeviceServiceState,
  type DeviceSession,
  type DeviceSummary,
} from "../../../renderer/shared/devices.js";

export const DEVICE_TOOL_NAMES = ["device_list", "device_open", "device_screenshot", "device_close"] as const;
/** Booting a simulator and powering one off change the user's machine; both need approval under "ask". */
export const DEVICE_APPROVAL_TOOL_NAMES: ReadonlySet<string> = new Set(["device_open", "device_close"]);
const deviceToolNames: ReadonlySet<string> = new Set(DEVICE_TOOL_NAMES);
export const isDeviceToolName = (name: string): boolean => deviceToolNames.has(name);

/** The always-on prompt block. Driving guidance lives in the `device_open` result. */
export const DEVICE_AGENT_GUIDANCE = [
  "For iOS Simulator work use the device tools: device_list, then device_open, which shows the device in the Simulator tab and returns the agent-device command to drive it.",
  "Verify results with device_screenshot. Close devices you opened with device_close when the task is done.",
  "Do not call simctl, xcrun, or serve-sim directly while a device is attached; use agent-device.",
].join("\n");

export const DEVICE_ACCESS_OFF =
  "Agent access to simulators is off. Ask the user to allow it in the Simulator tab.";
const DEVICE_SUPPORT_OFF =
  "Device support is off. Ask the user to enable it in the Simulator tab before installing or starting device tools.";

export function canUseDeviceTools(input: {
  enabled: boolean;
  agentAccess: boolean;
  permission: string;
  rendererOwner: boolean;
  assistantMode: boolean;
  bot: boolean;
}): boolean {
  return (
    input.enabled &&
    input.agentAccess &&
    input.rendererOwner &&
    !input.assistantMode &&
    !input.bot &&
    (input.permission === "full" || input.permission === "ask")
  );
}

export function deviceToolApprovalSummary(name: string, args: Record<string, unknown> = {}): string {
  const target = typeof args.deviceId === "string" ? ` ${args.deviceId}` : "";
  if (name === "device_open") {
    return `Open simulator${target || " (a booted one, or the first available)"} in the Simulator tab and let the agent drive it. This may boot it.`;
  }
  if (name === "device_close") {
    return args.shutdown === true
      ? `Close simulator${target} and shut it down.`
      : `Close simulator${target} in the Simulator tab. It keeps running.`;
  }
  return `Use simulator tool ${name}.`;
}

const SHELL_SAFE = /^[a-zA-Z0-9_./:=@-]+$/u;
export const shellQuote = (value: string): string =>
  SHELL_SAFE.test(value) ? value : `'${value.split("'").join(`'"'"'`)}'`;

/** The flags that pin every agent-device command to one device. */
export function agentDeviceTargetArgs(device: Pick<DeviceSummary, "id">): string[] {
  return ["--platform", "ios", "--udid", device.id];
}

/**
 * Just-in-time guidance returned from `device_open`. Chats that never open a
 * device never pay for it.
 */
export function agentDeviceQuickStart(
  device: Pick<DeviceSummary, "name" | "version">,
  targetArgs: readonly string[],
  command = "agent-device",
): string {
  const executable = shellQuote(command);
  const target = targetArgs.map(shellQuote).join(" ");
  return [
    `The user is watching ${device.name} (${device.version}) in the Simulator tab.`,
    `Drive it with ${executable}. Use this exact executable path; login shells may reset PATH. Always pass ${target}.`,
    "Typical loop:",
    `  ${executable} open <bundle-id> ${target}     # or: open <app> <deep-link-url>`,
    `  ${executable} snapshot -i ${target}          # accessibility tree with @eN refs`,
    `  ${executable} click @e3 ${target}`,
    `  ${executable} fill @e5 "text" ${target}`,
    `  ${executable} screenshot /tmp/shot.png ${target}   # or call device_screenshot`,
    `  ${executable} install <app> <path-to-.app> ${target}`,
    `Prefer snapshot refs over coordinates. Run ${executable} help for workflow guides and ${executable} <command> --help for flags.`,
    "Do not call simctl, xcrun, or serve-sim directly while these tools are attached; use agent-device.",
    "Keep the returned --config and --session flags on every command.",
    "First use builds an XCTest runner and can take a couple of minutes; later commands are fast.",
  ].join("\n");
}

/** Width and height from the IHDR chunk; a PNG that lacks one reports 0×0. */
export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const isPng =
    view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452;
  return isPng ? { width: view.getUint32(16), height: view.getUint32(20) } : { width: 0, height: 0 };
}

/** Picks the explicit device, else a booted one, else the first listed. */
export function pickDevice(
  devices: readonly DeviceSummary[],
  input: { deviceId?: string; hostId?: string },
): DeviceSummary {
  const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
  if (input.deviceId !== undefined) {
    const match = devices.find((device) => device.hostId === hostId && device.id === input.deviceId);
    if (match) return match;
    throw new Error(`No device ${input.deviceId} on host ${hostId}. Call device_list for current ids.`);
  }
  const candidates = devices.filter((device) => device.hostId === hostId);
  if (candidates.length === 0) throw new Error("No simulators were found. Call device_list to see why.");
  return candidates.find((device) => device.booted) ?? candidates[0]!;
}

/** What the tools need from the device service. Main binds it; model input cannot retarget the chat. */
export interface DeviceToolPort {
  refresh(): Promise<DeviceServiceState>;
  state(): DeviceServiceState;
  open(input: { chatId: string; hostId: string; deviceId: string; openedBy: "agent" }): Promise<DeviceSession>;
  close(input: { chatId: string; hostId: string; deviceId: string; shutdown?: boolean }): Promise<void>;
  screenshot(input: { hostId: string; deviceId: string }): Promise<Buffer>;
  /** Starts agent-device and returns the launcher path plus `--config`/`--session` flags for this chat. */
  agentTarget(input: { chatId: string; hostId: string; deviceId: string }): Promise<{ command: string; args: string[] }>;
  /** Shows the Simulator tab for this chat. */
  reveal(chatId: string): void;
}

export interface DeviceToolContext {
  chatId: string;
  signal: AbortSignal;
  supportsImages: boolean;
  port: DeviceToolPort;
  /** Re-checks consent and generation liveness before every call. */
  revalidate?(): Promise<void>;
  /** Where a screenshot lands when the model cannot take images. */
  screenshotDir?(): Promise<string>;
}

type Args = Record<string, unknown>;
const text = (value: unknown): AgentToolResult<null> => ({
  content: [{ type: "text", text: JSON.stringify(value ?? null) }],
  details: null,
});
const id = (description: string) =>
  Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9-]+$", description }));
const hostId = id("Device host. Defaults to this Mac (\"local\").");
const deviceId = id("Simulator UDID from device_list.");

function requireState(state: DeviceServiceState): DeviceServiceState {
  if (state.hostStatus === "needs-consent" || !state.consent.streaming) throw new Error(DEVICE_SUPPORT_OFF);
  if (!state.consent.agentAccess) throw new Error(DEVICE_ACCESS_OFF);
  return state;
}

export function createDeviceAgentTools(context: DeviceToolContext): AgentTool[] {
  if (!context.chatId) throw new Error("Device tools require a chat.");
  const { chatId, port } = context;
  const definitions = [
    [
      "device_list",
      "List devices",
      "List iOS Simulators on this Mac, whether each is booted, and which are already open in this chat's Simulator tab. Call this before device_open when you do not know a device id.",
      Type.Object({ hostId }, { additionalProperties: false }),
    ],
    [
      "device_open",
      "Open device",
      "Open an iOS Simulator for this chat: boots it if needed, starts its live stream, and shows it in the user's Simulator tab so they can watch. Returns the agent-device CLI invocation pinned to the device; drive the device with that CLI afterwards.",
      Type.Object({ hostId, deviceId }, { additionalProperties: false }),
    ],
    [
      "device_screenshot",
      "Screenshot device",
      "Capture the current screen of an open simulator as a PNG. Use it to see what the user sees; for taps and text use the agent-device CLI.",
      Type.Object({ hostId, deviceId }, { additionalProperties: false }),
    ],
    [
      "device_close",
      "Close device",
      "Remove a simulator from this chat's Simulator tab. Pass shutdown=true to also power it off.",
      Type.Object({ hostId, deviceId, shutdown: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    ],
  ] as const;

  const run = async (name: string, args: Args, signal: AbortSignal): Promise<AgentToolResult<null>> => {
    const live = () => {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Device tool cancelled.");
    };
    live();
    await context.revalidate?.();
    live();
    const requestedHost = typeof args.hostId === "string" ? args.hostId : undefined;
    const requestedDevice = typeof args.deviceId === "string" ? args.deviceId : undefined;

    if (name === "device_list") {
      const state = requireState(await port.refresh());
      return text({
        hostStatus: state.hostStatus,
        ...(state.unavailableReason ? { unavailableReason: state.unavailableReason } : {}),
        devices: state.devices
          .filter((device) => !requestedHost || device.hostId === requestedHost)
          .map(({ hostId: host, id: udid, name: deviceName, version, booted, kind }) => ({
            hostId: host,
            id: udid,
            name: deviceName,
            version,
            booted,
            kind,
          })),
        open: state.sessions
          .filter((session) => session.chatId === chatId)
          .map((session) => ({ hostId: session.hostId, deviceId: session.deviceId })),
      });
    }

    if (name === "device_open") {
      let state = requireState(port.state());
      if (state.devices.length === 0) state = requireState(await port.refresh());
      live();
      const target = pickDevice(state.devices, { deviceId: requestedDevice, hostId: requestedHost });
      // Consent and agent readiness resolve before anything boots or a session registers.
      const agent = await port.agentTarget({ chatId, hostId: target.hostId, deviceId: target.id });
      live();
      const alreadyOpen = port
        .state()
        .sessions.some(
          (candidate) =>
            candidate.chatId === chatId && candidate.hostId === target.hostId && candidate.deviceId === target.id,
        );
      const session = await port.open({ chatId, hostId: target.hostId, deviceId: target.id, openedBy: "agent" });
      if (signal.aborted) {
        // A stopped generation leaves nothing behind: no new session and no tab jumping forward.
        if (!alreadyOpen) {
          await port.close({ chatId, hostId: session.hostId, deviceId: session.deviceId }).catch(() => undefined);
        }
        live();
      }
      port.reveal(chatId);
      const device =
        port.state().devices.find((candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId) ??
        target;
      const targetArgs = [...agentDeviceTargetArgs(device), ...agent.args];
      return text({
        device: { hostId: device.hostId, id: device.id, name: device.name, version: device.version, booted: device.booted },
        agentDevice: { command: agent.command, targetArgs },
        quickStart: agentDeviceQuickStart(device, targetArgs, agent.command),
      });
    }

    const state = requireState(port.state());
    const sessions = state.sessions.filter(
      (session) => session.chatId === chatId && (!requestedHost || session.hostId === requestedHost),
    );
    const session = requestedDevice
      ? sessions.find((candidate) => candidate.deviceId === requestedDevice)
      : sessions[sessions.length - 1];
    if (!session) {
      throw new Error(
        requestedDevice
          ? `Device ${requestedDevice} is not open in this chat. Call device_open first.`
          : "No device is open in this chat. Call device_open first.",
      );
    }
    const target = { hostId: session.hostId, deviceId: session.deviceId };

    if (name === "device_screenshot") {
      const png = await port.screenshot(target);
      live();
      const dimensions = pngDimensions(png);
      const device = state.devices.find((candidate) => candidate.hostId === target.hostId && candidate.id === target.deviceId);
      const summary = { device: { ...target, name: device?.name ?? target.deviceId }, ...dimensions };
      if (context.supportsImages) {
        return {
          content: [
            { type: "text", text: JSON.stringify(summary) },
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          ],
          details: null,
        };
      }
      const directory = context.screenshotDir
        ? await context.screenshotDir()
        : await mkdtemp(path.join(tmpdir(), "aiden-device-shot-"));
      const file = path.join(directory, `simulator-${Date.now()}.png`);
      await writeFile(file, png, { mode: 0o600 });
      return text({ ...summary, path: file, note: "This model cannot view images; the screenshot was saved to path." });
    }

    await port.close({ chatId, ...target, ...(args.shutdown === true ? { shutdown: true } : {}) });
    return text({ closed: target, shutdown: args.shutdown === true });
  };

  return definitions.map(([name, label, description, parameters]) => {
    const tool: AgentTool = {
      name,
      label,
      description,
      parameters,
      execute: async (callId, raw, callSignal) => {
        const args = validateToolArguments(tool, { type: "toolCall", id: callId, name, arguments: raw as Args }) as Args;
        const signal = callSignal ? AbortSignal.any([context.signal, callSignal]) : context.signal;
        return run(name, args, signal);
      },
    };
    return tool;
  });
}
