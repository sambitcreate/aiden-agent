import {
  Navigate,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import * as React from "react";
import { RootView } from "./root-view";
import { ChatLayout, ChatIndex } from "./chat-layout";
import { ChatPane } from "./chat-pane";
import { QueryClient } from "@tanstack/react-query";
import { ErrorBoundaryView } from "../components/ui";
import { parseSettingsSearch } from "../lib/settings-section";
import { useAppCapabilities } from "../lib/app-capabilities";

// Chat is the startup surface, so only its shell and pane are in the entry
// chunk. Every other route loads its own chunk; the router awaits the chunk
// before committing the navigation, so the previous view stays on screen
// instead of flashing a placeholder.
const SettingsView = lazyRouteComponent(() => import("./settings-view"), "SettingsView");
const ProfileView = lazyRouteComponent(() => import("./profile-view"), "ProfileView");
const ScheduledTasksView = lazyRouteComponent(
  () => import("../components/scheduled-tasks-view"),
  "ScheduledTasksView",
);
const BotsView = lazyRouteComponent(() => import("./bots-view"), "BotsView");
const BotChatRouteView = lazyRouteComponent(() => import("./bot-chat-route"), "BotChatRoute");

/** Let the router preload the lazy view a wrapper route component renders. */
function preloadsWith<P>(
  component: (props: P) => React.ReactNode,
  ...lazy: Array<{ preload?: () => Promise<void> }>
) {
  return Object.assign(component, {
    preload: () => Promise.all(lazy.map((view) => view.preload?.())).then(() => undefined),
  });
}

function BotsCapabilityRoute({ children }: React.PropsWithChildren) {
  const capabilities = useAppCapabilities();
  return capabilities.bots ? children : <Navigate to="/" replace />;
}

const BotsRoute = preloadsWith(function BotsRoute() {
  return (
    <BotsCapabilityRoute>
      <BotsView />
    </BotsCapabilityRoute>
  );
}, BotsView);

const rootRoute = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootView,
  errorComponent: ErrorBoundaryView,
  notFoundComponent: () => {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <div className="drag-region fixed top-0 left-0 right-0 h-13" />
        <p className="text-secondary">Route not found</p>
      </div>
    );
  },
});

// Persistent chat shell (sidebar + content) hosting the index redirect and chats.
const chatLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "chatLayout",
  component: ChatLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => chatLayoutRoute,
  path: "/",
  component: ChatIndex,
  staticData: { title: "Aiden Agent" },
});

const chatRoute = createRoute({
  getParentRoute: () => chatLayoutRoute,
  path: "/chat/$chatId",
  // No `key={chatId}`: ChatPane resets its own per-chat state (see the chatId
  // layout effects there), so remounting only throws away the measured chrome
  // and scroll position, which reads as a blank-then-snap on every switch.
  component: function ChatRoute() {
    const { chatId } = chatRoute.useParams();
    return <ChatPane chatId={chatId} />;
  },
  staticData: { title: "Chat" },
});

const profileRoute = createRoute({
  getParentRoute: () => chatLayoutRoute,
  path: "/profile",
  component: ProfileView,
  staticData: { title: "Profile" },
});

const scheduledRoute = createRoute({
  getParentRoute: () => chatLayoutRoute,
  path: "/scheduled",
  component: ScheduledTasksView,
  staticData: { title: "Scheduled tasks" },
});

const botsRoute = createRoute({
  getParentRoute: () => chatLayoutRoute,
  path: "/bots",
  component: BotsRoute,
  staticData: { title: "Bots" },
});

const botRoute = createRoute({
  getParentRoute: () => chatLayoutRoute,
  path: "/bots/$botId",
  component: BotsRoute,
  staticData: { title: "Bot" },
});

const botChatRoute = createRoute({
  getParentRoute: () => chatLayoutRoute,
  path: "/bots/$botId/chat/$chatId",
  component: preloadsWith(function BotChatRoute() {
    const { botId, chatId } = botChatRoute.useParams();
    return (
      <BotsCapabilityRoute>
        <BotChatRouteView botId={botId} chatId={chatId} />
      </BotsCapabilityRoute>
    );
  }, BotChatRouteView),
  staticData: { title: "Bot conversation" },
});

// Full-screen settings (outside the chat shell).
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  validateSearch: parseSettingsSearch,
  component: preloadsWith(function SettingsRoute() {
    const { section } = settingsRoute.useSearch();
    return <SettingsView initialSection={section} />;
  }, SettingsView),
  staticData: { title: "Settings" },
});

const routeTree = rootRoute.addChildren([
  chatLayoutRoute.addChildren([
    indexRoute,
    chatRoute,
    profileRoute,
    scheduledRoute,
    botsRoute,
    botRoute,
    botChatRoute,
  ]),
  settingsRoute,
]);

const queryClient = new QueryClient();

const router = createRouter({
  routeTree,
  history: createMemoryHistory(),
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  context: {
    queryClient,
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    title?: string;
    component?: any;
  }
}

export { router, queryClient };
