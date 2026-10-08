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
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import { StudioCapabilityRoute } from "./studio-capability-route";

async function render(path: string, flags: { designStudio: boolean; createImages: boolean }) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => <p>home</p> });
  const design = createRoute({
    getParentRoute: () => root,
    path: "/design",
    component: () => (
      <StudioCapabilityRoute feature="designStudio">
        <p>design body</p>
      </StudioCapabilityRoute>
    ),
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
    routeTree: root.addChildren([home, design, images]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, ...flags }}>
      <RouterProvider router={router} />
    </AppCapabilitiesProvider>,
  );
}

test("studio routes render none of their feature while its capability is off", async () => {
  const off = { designStudio: false, createImages: false };
  assert.equal((await render("/design", off)).includes("design body"), false);
  assert.equal((await render("/images", off)).includes("images body"), false);
});

test("each studio route renders only under its own capability", async () => {
  assert.match(await render("/design", { designStudio: true, createImages: false }), /design body/u);
  assert.equal(
    (await render("/images", { designStudio: true, createImages: false })).includes("images body"),
    false,
  );
  assert.match(await render("/images", { designStudio: false, createImages: true }), /images body/u);
});
