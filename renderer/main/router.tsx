import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  useNavigate,
} from "@tanstack/react-router";
import * as React from "react";
import { RootView } from "./root-view";
import { ChatLayout, ChatIndex } from "./chat-layout";
import { ChatPane } from "./chat-pane";
import { SettingsView } from "./settings-view";
import { ProfileView } from "./profile-view";
import { ScheduledTasksView } from "../components/scheduled-tasks-view";
import { QueryClient } from "@tanstack/react-query";
import { ErrorBoundaryView } from "../components/ui";
import { parseSettingsSearch } from "../lib/settings-section";
import { useAppCapabilities } from "../lib/app-capabilities";

const LazyCreateImagesIndexView = React.lazy(() =>
  import("../create-images/create-images-view").then(({ CreateImagesIndexView }) => ({
    default: CreateImagesIndexView,
  })),
);

const LazyCreateImagesWorkflowView = React.lazy(() =>
  import("../create-images/create-images-view").then(({ CreateImagesWorkflowView }) => ({
    default: CreateImagesWorkflowView,
  })),
);

function CreateImagesCapabilityGate({ children }: React.PropsWithChildren) {
  const { createImages } = useAppCapabilities();
  const navigate = useNavigate();

  React.useEffect(() => {
    if (!createImages) void navigate({ to: "/", replace: true });
  }, [createImages, navigate]);

  if (!createImages) {
    return (
      <div className="flex h-full items-center justify-center p-6" role="status">
        <p className="text-small text-secondary">Create Images is unavailable in this build.</p>
      </div>
    );
  }

  return (
    <React.Suspense
      fallback={
        <div className="flex h-full items-center justify-center p-6" role="status">
          <p className="text-small text-secondary">Opening Create Images…</p>
        </div>
      }
    >
      {children}
    </React.Suspense>
  );
}

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

const createImagesIndexRoute = createRoute({
  getParentRoute: () => chatLayoutRoute,
  path: "/create-images",
  component: function CreateImagesIndexRoute() {
    return (
      <CreateImagesCapabilityGate>
        <LazyCreateImagesIndexView />
      </CreateImagesCapabilityGate>
    );
  },
  staticData: { title: "Create Images" },
});

const createImagesWorkflowRoute = createRoute({
  getParentRoute: () => chatLayoutRoute,
  path: "/create-images/$workflowId",
  component: function CreateImagesWorkflowRoute() {
    const { workflowId } = createImagesWorkflowRoute.useParams();
    return (
      <CreateImagesCapabilityGate>
        <LazyCreateImagesWorkflowView workflowId={workflowId} />
      </CreateImagesCapabilityGate>
    );
  },
  staticData: { title: "Image workflow" },
});

// Full-screen settings (outside the chat shell).
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  validateSearch: parseSettingsSearch,
  component: function SettingsRoute() {
    const { section } = settingsRoute.useSearch();
    return <SettingsView initialSection={section} />;
  },
  staticData: { title: "Settings" },
});

const routeTree = rootRoute.addChildren([
  chatLayoutRoute.addChildren([
    indexRoute,
    chatRoute,
    profileRoute,
    scheduledRoute,
    createImagesIndexRoute,
    createImagesWorkflowRoute,
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
