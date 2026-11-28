// A new design app's `/` on the canvas (design mode v2 Phase 3d, S113). Once
// the scaffolded app first runs, its home page is placed once as an app frame
// on the page the scaffold was asked from: the turn's page for Aiden, the page
// on screen for the person. 3b's entry fallback can't do this (it places only
// on an empty page), so this places `/` beside whatever the page holds, through
// the same written-route placement, or focuses the `/` frame already there.

import type { DesignTurnPages } from "./views.js";
import type { DesignCanvasUpdated, DesignChatCanvases } from "./store.js";
import { placeWrittenPagesOnCanvas } from "./written-pages.js";

export const MOCK_HOME_ROUTE = "/";

export interface MockHomeDeps {
  store: Pick<DesignChatCanvases, "get" | "update" | "workspaceIdOf">;
  broadcast(update: DesignCanvasUpdated): void;
  newId(): string;
  isLive?(chatIds: string[], workspaceId: string): Promise<Set<string>>;
  /** Whether the chat is in design mode now; asked before, during and after the write. */
  inDesignMode(chatId: string): Promise<boolean>;
  /** Shows the frames in the window that asked (`designCanvas:focus`). */
  focus(request: { chatId: string; pageId: string; frameIds: readonly string[]; focusId?: number }): void;
  /** `design_app_frame_added` call site 7: only for a frame this call placed. */
  onAppFrameAdded(width: number): void;
}

export interface MockHomeInput {
  chatId: string;
  workspaceId: string;
  workspaceRoot: string;
  appRoot: string;
  /** The page the scaffold was asked from: the turn's resolver, or the person's page on screen. */
  pages: Pick<DesignTurnPages, "resolver" | "show">;
}

/** Places the design app's `/` (`placed`), focuses the one already on that page (`already`), or does nothing (`refused`). */
export async function placeMockHome(input: MockHomeInput, deps: MockHomeDeps): Promise<"placed" | "already" | "refused"> {
  const stillHere = async () => (await deps.store.workspaceIdOf(input.chatId)) === input.workspaceId && (await deps.inDesignMode(input.chatId));
  if (!(await stillHere())) return "refused";
  const { doc } = await deps.store.get(input.chatId, { workspaceId: input.workspaceId });
  const view = (await input.pages.resolver(input.workspaceId))(doc);
  const existing = doc.frames.find(
    (frame) => frame.kind === "app" && frame.pageId === view.pageId && (frame.appRoot ?? ".") === input.appRoot && (frame.route ?? MOCK_HOME_ROUTE) === MOCK_HOME_ROUTE,
  );
  if (existing) {
    const focusId = await input.pages.show(input.workspaceId, view.pageId, stillHere);
    if (!(await stillHere())) return "refused";
    deps.focus({ chatId: input.chatId, pageId: view.pageId, frameIds: [existing.id], ...(focusId !== undefined ? { focusId } : {}) });
    return "already";
  }
  const placed = await placeWrittenPagesOnCanvas({
    chatId: input.chatId,
    workspaceRoot: input.workspaceRoot,
    paths: [],
    routes: [{ appRoot: input.appRoot, route: MOCK_HOME_ROUTE }],
    workspaceId: input.workspaceId,
    shouldSave: () => deps.inDesignMode(input.chatId),
    store: deps.store,
    pages: input.pages,
    broadcast: deps.broadcast,
    newId: deps.newId,
    ...(deps.isLive ? { isLive: deps.isLive } : {}),
  });
  if (placed.added.length === 0) return "refused";
  if (placed.frameIds.length > 0 && placed.pageId) {
    deps.focus({ chatId: input.chatId, pageId: placed.pageId, frameIds: placed.frameIds, ...(placed.focusId !== undefined ? { focusId: placed.focusId } : {}) });
  }
  for (const width of placed.added) {
    try {
      deps.onAppFrameAdded(width);
    } catch {
      // Reporting never changes the placement.
    }
  }
  return "placed";
}
