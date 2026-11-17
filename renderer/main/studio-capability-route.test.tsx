import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  AppCapabilitiesProvider,
  DISABLED_APP_CAPABILITIES,
  type AppCapabilities,
} from "../lib/app-capabilities";
import { redirectRetiredRoute, StudioCapabilityRoute } from "./studio-capability-route";

const EVERY_CAPABILITY = Object.fromEntries(
  Object.entries(DISABLED_APP_CAPABILITIES).map(([key, value]) => [key, typeof value === "boolean" ? true : value]),
) as unknown as AppCapabilities;

async function render(path: string, capabilities: AppCapabilities) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => <p>home</p> });
  const design = createRoute({ getParentRoute: () => root, path: "/design", beforeLoad: redirectRetiredRoute });
  const designProject = createRoute({
    getParentRoute: () => root,
    path: "/design/$projectId",
    beforeLoad: redirectRetiredRoute,
  });
  const images = createRoute({
    getParentRoute: () => root,
    path: "/images",
    component: () => (
      <StudioCapabilityRoute feature="createImages">
        <p>images body</p>
      </StudioCapabilityRoute>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([home, design, designProject, images]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  // Under Node the router resolves as a server and reports a redirect instead of following it;
  // follow it the way the client router does.
  const redirect = router.state.redirect;
  if (redirect) await router.navigate({ ...redirect.options, replace: true });
  const markup = renderToStaticMarkup(
    <AppCapabilitiesProvider capabilities={capabilities}>
      <RouterProvider router={router} />
    </AppCapabilitiesProvider>,
  );
  return { markup, pathname: router.state.location.pathname };
}

test("Images renders only while its capability is on", async () => {
  assert.equal((await render("/images", DISABLED_APP_CAPABILITIES)).markup.includes("images body"), false);
  assert.match(
    (await render("/images", { ...DISABLED_APP_CAPABILITIES, createImages: true })).markup,
    /images body/u,
  );
});

test("a stale Design Studio link lands on the chat home even with every capability on", async () => {
  for (const path of ["/design", "/design/project-1"]) {
    const { markup, pathname } = await render(path, EVERY_CAPABILITY);
    assert.equal(pathname, "/", path);
    assert.match(markup, /home/u, path);
  }
  assert.match((await render("/images", EVERY_CAPABILITY)).markup, /images body/u);
});
