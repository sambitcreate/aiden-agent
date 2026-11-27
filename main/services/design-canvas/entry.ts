// What runs when a chat turns design mode on, by the Design toggle or
// Aiden's card: the chat claims its page of the workspace canvas, its
// earlier pages land there, the canvas is asked to show it, and a page made
// for the chat takes its newest title. The run is tracked in
// `PendingEntries`, so the chat's turn writes wait for its claim. With live
// app frames on (3b, S83), the chat's route files land too, or a single app's
// `/` when the chat wrote nothing.

import type { DesignAppsSnapshot } from "../../../renderer/shared/design-app.js";
import type { CanvasConfig } from "./canvas-config.js";
import type { DesignTitleFollow } from "./title-follow.js";
import type { DesignCanvasUpdated, DesignChatCanvases } from "./store.js";
import { designTurnPages, type DesignCanvasViews } from "./views.js";
import {
  EARLIER_PAGES_LIMIT,
  isAutoPlacedPagePath,
  isShowablePage,
  pagesWrittenInChat,
  placeWrittenPagesOnCanvas,
  writtenAppRoute,
  writtenRouteData,
  writtenRoutePattern,
  type PendingEntries,
  type RecentWrittenPages,
  type WrittenAppRoute,
} from "./written-pages.js";

/** The chat as entry reads it: its id, title and saved messages. */
type EnteringChat = { id: string; title: string; messages: Parameters<typeof pagesWrittenInChat>[0] };

export function createDesignEntry(deps: {
  store: Pick<DesignChatCanvases, "get" | "update" | "workspaceIdOf">;
  views: Pick<DesignCanvasViews, "get" | "viewports" | "showPage" | "pageIdsOf">;
  recent: Pick<RecentWrittenPages, "merged">;
  pending: Pick<PendingEntries, "track">;
  titleFollow: Pick<DesignTitleFollow, "follow">;
  isLive(chatIds: string[], workspaceId: string): Promise<Set<string>>;
  /** Checked on the canvas's chain before the write: false once design mode is off or the chat is gone. */
  designModeOn(chatId: string): Promise<boolean>;
  broadcast(update: DesignCanvasUpdated): void;
  /** Asks the canvas to show the chat's page and fit these frames. */
  focus(request: { chatId: string; pageId: string; frameIds: string[]; focusId?: number }): void;
  newId(): string;
  /**
   * 3b (S83), live app frames on: the workspace's apps and canvas.json, so the
   * chat's route files land as app frames beside its pages, or, when it wrote
   * nothing, a single app's `/`. Each kept app frame is reported (S88).
   */
  live?: {
    snapshot(workspaceId: string): Promise<DesignAppsSnapshot>;
    readConfig(workspaceRoot: string): Promise<CanvasConfig | null>;
    onAppFrameAdded(viewportWidth: number): void;
  };
}): (chat: EnteringChat, workspaceRoot: string) => Promise<void> {
  /** Today's pages, or with live frames the newest 12 pages and routes of one timeline, and the `/` fallback. */
  const written = async (
    chat: EnteringChat,
    workspaceRoot: string,
  ): Promise<{ paths: string[]; routes?: WrittenAppRoute[]; fallbackRoute?: WrittenAppRoute; workspaceId?: string }> => {
    const live = deps.live;
    const workspaceId = live ? await deps.store.workspaceIdOf(chat.id) : null;
    // A reply still running has not saved its activity yet; its pages come from this run's record.
    if (!live || workspaceId === null) return { paths: deps.recent.merged(chat.id, pagesWrittenInChat(chat.messages)) };
    const [snapshot, config] = await Promise.all([live.snapshot(workspaceId).catch(() => null), live.readConfig(workspaceRoot).catch(() => null)]);
    const data = writtenRouteData(snapshot, config);
    const timeline = deps.recent.merged(
      chat.id,
      pagesWrittenInChat(chat.messages, { isRouteFile: (relativePath) => writtenRoutePattern(relativePath, data) !== null }),
    );
    const paths: string[] = [];
    const routes: WrittenAppRoute[] = [];
    // Newest first, up to 12 across both kinds: a page counts once it still exists, a route once it maps to one.
    for (let index = timeline.length - 1; index >= 0 && paths.length + routes.length < EARLIER_PAGES_LIMIT; index -= 1) {
      const relativePath = timeline[index]!;
      if (isAutoPlacedPagePath(relativePath)) {
        if (await isShowablePage(workspaceRoot, relativePath)) paths.unshift(relativePath);
        continue;
      }
      const route = writtenAppRoute(relativePath, data);
      if (route && !routes.some((entry) => entry.appRoot === route.appRoot && entry.route === route.route)) routes.unshift(route);
    }
    const single =
      snapshot?.target === "single"
        ? (snapshot.candidates.length === 1 ? snapshot.candidates[0]!.appRoot : snapshot.apps.length === 1 ? snapshot.apps[0]!.appRoot : undefined)
        : undefined;
    const wroteNothing = timeline.length === 0;
    return { paths, routes, workspaceId, ...(wroteNothing && single !== undefined ? { fallbackRoute: { appRoot: single, route: "/" } } : {}) };
  };
  return (chat, workspaceRoot) =>
    deps.pending.track(
      chat.id,
      (async () => {
        const { paths, routes, fallbackRoute, workspaceId } = await written(chat, workspaceRoot);
        const { frameIds, pageId, focusId, added } = await placeWrittenPagesOnCanvas({
          chatId: chat.id,
          workspaceRoot,
          paths,
          ...(routes ? { routes } : {}),
          ...(fallbackRoute ? { fallbackRoute } : {}),
          // The routes came from this workspace's apps, so they land only while the chat is still there.
          ...(workspaceId !== undefined ? { workspaceId } : {}),
          limit: EARLIER_PAGES_LIMIT,
          shouldSave: () => deps.designModeOn(chat.id),
          store: deps.store,
          pages: designTurnPages({ views: deps.views, chatId: chat.id }),
          broadcast: deps.broadcast,
          newId: deps.newId,
          entry: {
            pageName: chat.title,
            otherViews: (workspaceId) => deps.views.pageIdsOf(workspaceId, chat.id),
            isLive: deps.isLive,
          },
        });
        // The canvas shows that page and fits the pages once it loads, so the person sees them whole.
        if (pageId && (frameIds.length > 0 || focusId !== undefined)) {
          deps.focus({ chatId: chat.id, pageId, frameIds, ...(focusId !== undefined ? { focusId } : {}) });
        }
        // S88, call site 3: each app frame entry kept.
        for (const width of added) {
          try {
            deps.live?.onAppFrameAdded(width);
          } catch {
            // Reporting never changes the entry.
          }
        }
        // The title may have changed while entry ran; a page made for the chat follows it.
        await deps.titleFollow.follow(chat.id);
      })(),
    );
}
