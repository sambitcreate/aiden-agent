import { createRouter, type AnyRoute, type RouterConstructorOptions, type RouterHistory } from "@tanstack/react-router";
import { carryBotListRequest } from "./bot-routes";
import { guardHistoryTraversal } from "./guarded-history";

/**
 * The app's router wiring, kept apart from the route modules so tests drive
 * the same wiring with their own route tree: Back and Forward run leave guards
 * (`guardHistoryTraversal`), and an ask for the Bot list rides on the entries
 * the router commits (`carryBotListRequest`).
 */
export function createAppRouter<TRouteTree extends AnyRoute>(
  options: RouterConstructorOptions<TRouteTree, "never", false, RouterHistory, Record<string, unknown>> & {
    history: RouterHistory;
  },
) {
  return carryBotListRequest(createRouter({ ...options, history: guardHistoryTraversal(options.history) }));
}
