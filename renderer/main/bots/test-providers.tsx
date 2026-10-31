import * as React from "react";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppCapabilitiesProvider, type AppCapabilities } from "../../lib/app-capabilities";
import { CommandSystemProvider } from "../../lib/command-system";
import { BotChatRoute } from "../bot-chat-route";
import { RoutedBotPanelProvider } from "./bot-panel-context";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
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

function BotChatFromParams() {
  const { botId } = useParams({ strict: false }) as { botId: string };
  return <BotChatRoute botId={botId} />;
}

export const BOT_TEST_PATHS = [
  "/",
  "/profile",
  "/scheduled",
  "/bots",
  "/bots/$botId",
  "/bots/$botId/chat",
  "/settings",
] as const;

interface BotRouterOptions {
  initialPath?: string;
  queryClient?: QueryClient;
  sidebar?: React.ReactNode;
  /** What this Mac offers, as main reports it; the app's disabled defaults when left out. */
  capabilities?: AppCapabilities;
}

/**
 * Mounts `children` at `initialPath` inside a memory router whose routes match
 * Aiden's Bot paths, so `useNavigate` works and tests can read the current
 * location from the returned router.
 */
export async function mountWithBotRouter(
  children: React.ReactNode,
  options: BotRouterOptions = {},
) {
  const harness = createBotRouterHarness(children, options);
  await harness.router.load();
  // The router settles its first match after mounting; let it inside act.
  await act(async () => {
    render(harness.element);
  });
  return { router: harness.router, queryClient: harness.queryClient };
}

function createBotRouterHarness(
  children: React.ReactNode,
  options: BotRouterOptions = {},
) {
  const queryClient = options.queryClient ?? createBotTestQueryClient();
  // As in the app: the Bot panel's state outlives route changes, and a sidebar
  // (when a test passes one) stays mounted beside the routed page.
  const rootRoute = createRootRoute({
    component: () => (
      <RoutedBotPanelProvider>
        {options.sidebar}
        <Outlet />
      </RoutedBotPanelProvider>
    ),
  });
  const routes = BOT_TEST_PATHS.map((path) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      // A Bot's conversation mounts its own route component, as in the app.
      component: path === "/bots/$botId/chat" ? BotChatFromParams : () => <>{children}</>,
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [options.initialPath ?? "/bots"] }),
  });
  const routed = (
    <QueryClientProvider client={queryClient}>
      <CommandSystemProvider>
        <RouterProvider router={router} />
      </CommandSystemProvider>
    </QueryClientProvider>
  );
  return {
    queryClient,
    router,
    element: options.capabilities ? (
      <AppCapabilitiesProvider capabilities={options.capabilities}>{routed}</AppCapabilitiesProvider>
    ) : (
      routed
    ),
  };
}
