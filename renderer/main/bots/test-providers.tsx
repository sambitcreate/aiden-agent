import * as React from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";

/** A query client that never schedules GC timers, so test processes exit. */
export function createBotTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

export const BOT_TEST_PATHS = [
  "/",
  "/bots",
  "/bots/$botId",
  "/bots/$botId/chat/$chatId",
  "/settings",
] as const;

/**
 * Mounts `children` at `initialPath` inside a memory router whose routes match
 * Aiden's Bot paths, so `useNavigate` works and tests can read the current
 * location from the returned router.
 */
export async function mountWithBotRouter(
  children: React.ReactNode,
  options: { initialPath?: string; queryClient?: QueryClient } = {},
) {
  const harness = createBotRouterHarness(children, options);
  await harness.router.load();
  render(harness.element);
  return { router: harness.router, queryClient: harness.queryClient };
}

function createBotRouterHarness(
  children: React.ReactNode,
  options: { initialPath?: string; queryClient?: QueryClient } = {},
) {
  const queryClient = options.queryClient ?? createBotTestQueryClient();
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const routes = BOT_TEST_PATHS.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => <>{children}</> }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [options.initialPath ?? "/bots"] }),
  });
  return {
    queryClient,
    router,
    element: (
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    ),
  };
}
