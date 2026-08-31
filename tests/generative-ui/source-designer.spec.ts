import playwrightTest from "@playwright/test";
import type * as PlaywrightTestModule from "@playwright/test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { RendererDocumentOwner } from "../../main/services/renderer-document-owner.js";
import { sourceDesignPreviewService } from "../../main/services/source-design-preview.js";
import { sourceDesignerActionService } from "../../main/services/source-designer-actions.js";
import {
  SOURCE_DESIGN_PICKER_COMMAND,
  SOURCE_DESIGN_PICKER_SELECTION,
  type SourceElementDescriptorV1,
} from "../../renderer/shared/source-designer.js";

const fixtureTemplateRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/source-design-vite",
);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const { expect, test } = playwrightTest as unknown as typeof PlaywrightTestModule;

function testOwner(documentId: string): RendererDocumentOwner {
  return {
    id: 1,
    documentId,
    isDestroyed: () => false,
    send: () => undefined,
    onInvalidated: () => () => undefined,
  };
}

test("local React preview binds the exact nested element to its JSX range", async ({ page }) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-source-designer-"));
  await fs.cp(fixtureTemplateRoot, fixtureRoot, { recursive: true });
  await fs.rm(path.join(fixtureRoot, "node_modules"), { recursive: true, force: true });
  await fs.symlink(path.join(repositoryRoot, "node_modules"), path.join(fixtureRoot, "node_modules"));
  const canonicalFixtureRoot = await fs.realpath(fixtureRoot);
  const owner = testOwner("source-designer-browser-fixture");
  const controller = new AbortController();
  const state = await sourceDesignPreviewService.start({
    owner,
    admission: {
      signal: controller.signal,
      cancel: (reason) => controller.abort(reason),
      release: () => undefined,
    },
    workspaceId: "source-designer-fixture",
    root: fixtureRoot,
    scriptId: "dev",
  });
  expect(state.status).toBe("running");
  if (state.status !== "running") return;
  try {
    await page.goto(state.src);
    await expect(page.getByTestId("exact-child")).toHaveText("Save");
    const descriptorPromise = page.evaluate(
      ({ command, selection, capability }) =>
        new Promise<unknown>((resolve) => {
          const receive = (event: MessageEvent) => {
            if (
              event.data?.type !== selection ||
              event.data?.capability !== capability
            ) {
              return;
            }
            window.removeEventListener("message", receive);
            resolve(event.data.descriptor);
          };
          window.addEventListener("message", receive);
          window.postMessage(
            {
              type: command,
              capability,
              enabled: true,
              selectedSelector: "",
            },
            "*",
          );
        }),
      {
        command: SOURCE_DESIGN_PICKER_COMMAND,
        selection: SOURCE_DESIGN_PICKER_SELECTION,
        capability: state.capability,
      },
    );
    await page.getByTestId("exact-child").click({ position: { x: 4, y: 4 } });
    const descriptor = (await descriptorPromise) as SourceElementDescriptorV1;
    expect(descriptor.selection.tagName).toBe("span");
    expect(descriptor.selection.selector).toContain("exact-child");
    expect(descriptor.filePath).toMatch(/main\.tsx$/u);

    const binding = await sourceDesignerActionService.bind(
      owner,
      "source-designer-fixture",
      state.sessionId,
      descriptor,
    );
    expect(binding.path).toBe("src/main.tsx");
    expect(binding.snippet).toContain('<span data-testid="exact-child">Save</span>');
    expect(binding.snippet).not.toContain("<button");

    const resolved = await sourceDesignerActionService.resolve(
      owner,
      "source-designer-fixture",
      binding.id,
    );
    const action = sourceDesignerActionService.propose({
      owner,
      chatId: "source-designer-chat",
      binding: resolved,
      label: "Change the save label",
      replacement: '<span data-testid="exact-child">Saved</span>',
    });
    expect(action.status).toBe("pending");
    expect((await fs.readFile(path.join(fixtureRoot, "src/main.tsx"), "utf8"))).toContain(
      ">Save</span>",
    );
    const applied = await sourceDesignerActionService.apply(
      owner,
      action.id,
      canonicalFixtureRoot,
      new AbortController().signal,
    );
    expect(applied.status).toBe("applied");
    expect((await fs.readFile(path.join(fixtureRoot, "src/main.tsx"), "utf8"))).toContain(
      ">Saved</span>",
    );
    const undone = await sourceDesignerActionService.undo(
      owner,
      action.id,
      canonicalFixtureRoot,
      new AbortController().signal,
    );
    expect(undone.status).toBe("undone");
    expect((await fs.readFile(path.join(fixtureRoot, "src/main.tsx"), "utf8"))).toContain(
      ">Save</span>",
    );

    const unmapped = page.getByText("Unmapped child", { exact: true });
    const unmappedDescriptorPromise = page.evaluate(
      ({ command, selection, capability }) =>
        new Promise<unknown>((resolve) => {
          const receive = (event: MessageEvent) => {
            if (event.data?.type !== selection || event.data?.capability !== capability) return;
            window.removeEventListener("message", receive);
            resolve(event.data.descriptor);
          };
          window.addEventListener("message", receive);
          window.postMessage(
            { type: command, capability, enabled: true, selectedSelector: "" },
            "*",
          );
        }),
      {
        command: SOURCE_DESIGN_PICKER_COMMAND,
        selection: SOURCE_DESIGN_PICKER_SELECTION,
        capability: state.capability,
      },
    );
    await unmapped.click({ position: { x: 4, y: 4 } });
    const unmappedDescriptor = (await unmappedDescriptorPromise) as SourceElementDescriptorV1;
    await assert.rejects(
      () => sourceDesignerActionService.bind(
        owner,
        "source-designer-fixture",
        state.sessionId,
        unmappedDescriptor,
      ),
      /could not bind that exact element/u,
    );
  } finally {
    await sourceDesignPreviewService.stop(owner, "source-designer-fixture");
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});
