// A Bot's computer floating over its chat (plan §8.5, Float over chat): the
// Simulator's floating player frame (`FloatingPlayerFrame`, its layout math
// and chat-area bounds) around the same screen the Computer tab shows. Its
// size and position are a per-window convenience kept in browser storage,
// apart from the Simulator player's, since a Mac display and a phone want
// different sizes.

import * as React from "react";
import { createPortal } from "react-dom";
import { FloatingPlayerFrame, useDocumentVisible } from "../../components/device-mini-player";
import type { BrowserFloatingSize } from "../../lib/browser-floating-layout";
import {
  DEFAULT_DEVICE_MINI_PLAYER_GEOMETRY,
  parseDeviceMiniPlayerGeometry,
  serializeDeviceMiniPlayerGeometry,
  type DeviceMiniPlayerGeometry,
} from "../../lib/device-mini-player-layout";
import type { BotComputerStatus } from "../../shared/bot-computers";
import {
  BOT_COMPUTER_DEFAULT_SCREEN,
  BotComputerControlButton,
  BotComputerView,
  type BotComputerStart,
  type ComputerBot,
} from "./bot-computer-tab";

export const BOT_COMPUTER_FLOAT_STORAGE_KEY = "aiden-agent.bots.computer-float-v1";

const listeners = new Set<() => void>();
let stored: DeviceMiniPlayerGeometry | null = null;

function readGeometry(): DeviceMiniPlayerGeometry {
  if (stored) return stored;
  try {
    stored = parseDeviceMiniPlayerGeometry(localStorage.getItem(BOT_COMPUTER_FLOAT_STORAGE_KEY));
  } catch {
    stored = DEFAULT_DEVICE_MINI_PLAYER_GEOMETRY;
  }
  return stored;
}

function writeGeometry(next: DeviceMiniPlayerGeometry): void {
  const current = readGeometry();
  if (current.width === next.width && current.position?.x === next.position?.x && current.position?.y === next.position?.y) return;
  stored = next;
  try {
    localStorage.setItem(BOT_COMPUTER_FLOAT_STORAGE_KEY, serializeDeviceMiniPlayerGeometry(next));
  } catch {
    // The size and position still apply in this window.
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * The floating computer, portalled over the chat. Dock puts it back in the
 * Computer tab and shows that tab; Close only stops floating. Escape docks,
 * except on the screen, where it is a key for the computer.
 */
export function BotComputerFloat({
  bot,
  computer,
  start,
  onDock,
  onClose,
}: {
  bot: ComputerBot;
  computer: BotComputerStatus;
  start: BotComputerStart;
  onDock(): void;
  onClose(): void;
}) {
  const visible = useDocumentVisible();
  const geometry = React.useSyncExternalStore(subscribe, readGeometry, readGeometry);
  const [screen, setScreen] = React.useState<BrowserFloatingSize | null>(null);
  const title = `${bot.name}'s computer`;
  return createPortal(
    <FloatingPlayerFrame
      title={title}
      source={screen ?? BOT_COMPUTER_DEFAULT_SCREEN}
      geometry={geometry}
      onGeometryChange={writeGeometry}
      roleDescription="floating computer"
      data={{ "data-bot-computer-float": bot.id }}
      actions={<BotComputerControlButton bot={bot} computer={computer} variant="float" />}
      dock={{ label: `Dock ${title} in the Bot panel`, title: "Dock in panel", onDock }}
      close={{ label: "Close floating computer", title: "Close floating computer", onClose }}
    >
      <BotComputerView bot={bot} computer={computer} active={visible} variant="float" start={start} onScreen={setScreen} />
    </FloatingPlayerFrame>,
    document.body,
  );
}
