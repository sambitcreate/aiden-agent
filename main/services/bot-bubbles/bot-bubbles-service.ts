// Bot bubbles: the one owner of the bubble list. Loads and saves
// `<userData>/bot-bubbles.json`, keeps it free of deleted Bots, derives the host
// from app settings and tells every window about each change. Electron-free;
// `bot-bubbles-main.ts` wires the real paths, settings and broadcasts.

import * as fs from "node:fs/promises";
import type { BotBubblePlacement, BotBubbleSide, BotBubbleState } from "../../../renderer/shared/bot-bubbles.js";
import { writeJsonAtomic } from "../durable-fs.js";
import {
  EMPTY_BOT_BUBBLE_LIST,
  botBubbleSettingsFrom,
  botBubbleStateFrom,
  bubbleBot,
  closeBubble,
  forgetRecentBubble,
  moveBubble,
  moveBubblesOffMissingDisplays,
  openBubble,
  parseBotBubbleFile,
  pruneBubbles,
  serializeBotBubbleFile,
  type BotBubbleAppSettings,
  type BotBubbleList,
} from "./bot-bubbles-core.js";

export interface BotBubbleServiceDependencies {
  filePath: string;
  platform: NodeJS.Platform;
  readSettings(): Promise<BotBubbleAppSettings>;
  botExists(botId: string): Promise<boolean>;
  listBotIds(): Promise<readonly string[]>;
  /** Every change, to every window that shows heads or bubble controls. */
  broadcast(state: BotBubbleState): void;
  onWarning?(message: string, error: unknown): void;
  /** Test seams; default to the real file system. */
  readFile?(filePath: string): Promise<string>;
  writeFile?(filePath: string, value: unknown): Promise<void>;
}

export type BotBubbleChangeListener = (state: BotBubbleState, previous: BotBubbleState) => void;

export interface BotBubbleService {
  /** Load the saved list once; every other call waits for it. */
  ready(): Promise<void>;
  state(): Promise<BotBubbleState>;
  /** The latest state without waiting (empty until loaded). */
  current(): BotBubbleState;
  openBotId(): string | null;
  bubble(botId: string, options?: { side?: BotBubbleSide; displayId?: number | null }): Promise<BotBubbleState>;
  close(botId: string): Promise<BotBubbleState>;
  /** With `ifOpen`, nothing changes unless that head's chat is the open one. */
  open(botId: string | null, options?: { ifOpen?: string }): Promise<BotBubbleState>;
  move(botId: string, placement: BotBubblePlacement): Promise<BotBubbleState>;
  forgetRecent(botId: string): Promise<BotBubbleState>;
  /** App settings changed: recompute the host. */
  syncSettings(settings: BotBubbleAppSettings): Promise<BotBubbleState>;
  /** A Bot changed or went away (no id: any Bot may have). */
  botsChanged(botId?: string): Promise<BotBubbleState>;
  /** Displays were added or removed; heads on a missing one go to the primary display. */
  displaysChanged(liveDisplayIds: ReadonlySet<number>, primaryDisplayId: number): Promise<BotBubbleState>;
  onChange(listener: BotBubbleChangeListener): () => void;
}

const sameList = (left: BotBubbleList, right: BotBubbleList) =>
  JSON.stringify(serializeBotBubbleFile(left)) === JSON.stringify(serializeBotBubbleFile(right));

export function createBotBubbleService(deps: BotBubbleServiceDependencies): BotBubbleService {
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFile(filePath, "utf8"));
  const writeFile =
    deps.writeFile ?? ((filePath: string, value: unknown) => writeJsonAtomic(filePath, value, { space: 2, trailingNewline: true }));
  const warn = (message: string, error: unknown) => deps.onWarning?.(message, error);

  let list: BotBubbleList = EMPTY_BOT_BUBBLE_LIST;
  let settings = botBubbleSettingsFrom({});
  let state = botBubbleStateFrom(list, settings, deps.platform);
  const listeners = new Set<BotBubbleChangeListener>();
  // One change at a time, so a save never races the next mutation.
  let queue: Promise<unknown> = Promise.resolve();
  let loading: Promise<void> | null = null;

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  const persist = async (next: BotBubbleList) => {
    try {
      await writeFile(deps.filePath, serializeBotBubbleFile(next));
    } catch (error) {
      // The list still works for this run; the next change tries again.
      warn("Could not save the Bot bubble list.", error);
    }
  };

  const commit = async (nextList: BotBubbleList, nextSettings = settings): Promise<BotBubbleState> => {
    const listChanged = !sameList(list, nextList);
    const previous = state;
    list = nextList;
    settings = nextSettings;
    state = botBubbleStateFrom(list, settings, deps.platform);
    if (listChanged) await persist(list);
    if (JSON.stringify(previous) !== JSON.stringify(state)) {
      try {
        deps.broadcast(state);
      } catch (error) {
        warn("Could not announce a Bot bubble change.", error);
      }
      for (const listener of [...listeners]) {
        try {
          listener(state, previous);
        } catch (error) {
          warn("A Bot bubble listener failed.", error);
        }
      }
    }
    return state;
  };

  const prune = async (current: BotBubbleList): Promise<BotBubbleList> => {
    if (current.bubbles.length === 0 && current.recents.length === 0) return current;
    return pruneBubbles(current, new Set(await deps.listBotIds()));
  };

  const ready = () => {
    loading ??= serial(async () => {
      let saved = EMPTY_BOT_BUBBLE_LIST;
      /** Whether the file held something the parse dropped (or wasn't JSON): replace it once. */
      let rewrite = false;
      try {
        const text = await readFile(deps.filePath);
        let raw: unknown;
        let parsed = true;
        try {
          raw = JSON.parse(text);
        } catch (error) {
          parsed = false;
          warn("The saved Bot bubble list was unreadable; starting empty.", error);
        }
        saved = parseBotBubbleFile(raw);
        rewrite = !parsed || JSON.stringify(serializeBotBubbleFile(saved)) !== JSON.stringify(raw);
        if (parsed && rewrite) warn("The saved Bot bubble list had entries Aiden can't use; starting without them.", null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") warn("Could not read the saved Bot bubble list.", error);
      }
      let nextSettings = settings;
      try {
        nextSettings = botBubbleSettingsFrom(await deps.readSettings());
      } catch (error) {
        warn("Could not read the Bot bubble settings.", error);
      }
      let pruned = saved;
      try {
        pruned = await prune(saved);
      } catch (error) {
        warn("Could not check which bubbled Bots still exist.", error);
      }
      // `commit` saves when pruning dropped a deleted Bot; a damaged or unknown
      // file is replaced too, so its warning doesn't repeat every launch.
      list = saved;
      await commit(pruned, nextSettings);
      if (rewrite && sameList(saved, pruned)) await persist(pruned);
    });
    return loading;
  };

  const mutate = (change: (current: BotBubbleList) => BotBubbleList | Promise<BotBubbleList>) =>
    ready().then(() => serial(async () => commit(await change(list))));

  return {
    ready,
    state: () => ready().then(() => state),
    current: () => state,
    openBotId: () => state.openBotId,
    bubble: (botId, options = {}) =>
      mutate(async (current) => {
        if (state.host === "off") throw new Error("Bubbles are turned off in Settings.");
        if (!(await deps.botExists(botId))) throw new Error("This Bot no longer exists.");
        return bubbleBot(current, botId, options);
      }),
    close: (botId) => mutate((current) => closeBubble(current, botId)),
    open: (botId, options = {}) => mutate((current) => openBubble(current, botId, options.ifOpen)),
    move: (botId, placement) => mutate((current) => moveBubble(current, botId, placement)),
    forgetRecent: (botId) => mutate((current) => forgetRecentBubble(current, botId)),
    syncSettings: (appSettings) =>
      ready().then(() =>
        serial(() => {
          const next = botBubbleSettingsFrom(appSettings);
          // Turning bubbles off tucks away the open chat; the heads come back when it is on again.
          return commit(next.enabled ? list : openBubble(list, null), next);
        }),
      ),
    botsChanged: (botId) =>
      mutate(async (current) => {
        if (botId !== undefined) {
          const named = current.bubbles.some((bubble) => bubble.botId === botId) || current.recents.includes(botId);
          if (!named || (await deps.botExists(botId))) return current;
          return pruneBubbles(current, new Set([...current.bubbles.map((b) => b.botId), ...current.recents].filter((id) => id !== botId)));
        }
        return prune(current);
      }),
    displaysChanged: (liveDisplayIds, primaryDisplayId) =>
      mutate((current) => moveBubblesOffMissingDisplays(current, liveDisplayIds, primaryDisplayId)),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
