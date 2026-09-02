import { app } from "../platform.js";
import { DesignCommentStore } from "./design-comment-store.js";

/**
 * Production main-process singleton. Initialization stays explicit so startup
 * can surface an unavailable store without silently replacing user data.
 */
export const designCommentStore = new DesignCommentStore({
  root: () => app.getPath("userData"),
});
