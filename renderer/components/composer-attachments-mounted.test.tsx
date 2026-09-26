import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { DOMImplementation } from "@xmldom/xmldom";
import * as React from "react";
import type { Composer } from "./composer.js";
import type { Attachment } from "../lib/types.js";
import { attachmentInlineBytesRemaining } from "../shared/attachment-contract.js";

// Mount the production Composer and its send/restore/attachment logic. Replace only
// peripheral UI, device hooks, and IPC; no lifecycle logic is copied into this fixture.
async function loadComposer() {
  const directory = await mkdtemp(path.resolve("node_modules/.composer-attachments-test-"));
  const outfile = path.join(directory, "composer.cjs");
  const stubs: Record<string, string> = {
    "./ui": `import React from 'react';
      const primitive = tag => ({children, ...props}) => React.createElement(tag,
        Object.fromEntries(Object.entries(props).filter(([key]) => /^(aria-|data-|on)/.test(key) || ['ref','value','disabled','readOnly','className','role'].includes(key))), children);
      export const Button=primitive('button'), Textarea=primitive('textarea'), Input=primitive('input'), Text=primitive('span');
      export const Dialog=()=>null, AlertDialog=()=>null, DropdownMenu=()=>null, DropdownMenuContent=()=>null, DropdownMenuItem=()=>null, DropdownMenuTrigger=()=>null;
      export const toast={info:()=>{},error:()=>{},success:()=>{}};`,
    "../lib/use-voice-recorder": "export const useVoiceRecorder=()=>({});",
    "../lib/queries":
      "export const useSettings=()=>({}); export const useDiscoveredSkills=()=>({});",
    "../lib/command-system":
      "export const useCommandSystem=()=>({canExecute:()=>false,execute:()=>false});",
    "../lib/ipc":
      "export const attachmentsApi=globalThis.__composerAttachmentFixture.api; export const browserApi={onEvent: callback => { globalThis.__composerAttachmentFixture.browserEvent=callback; return ()=>{}; }};",
    "./git-branch-picker": "export const GitBranchPicker=()=>null;",
    "./workspace-picker": "export const WorkspacePicker=()=>null;",
    "./composer-context-bar": "export const ComposerContextBar=()=>null;",
    "./chat-pull-requests": "export const ChatPullRequestsChip=()=>null;",
  };
  await build({
    entryPoints: [path.resolve("renderer/components/composer.tsx")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    external: ["react", "react/*", "react-dom", "react-dom/*"],
    plugins: [
      {
        name: "composer-peripherals",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) =>
            args.importer.endsWith("/composer.tsx") && args.path in stubs
              ? { path: args.path, namespace: "fixture" }
              : undefined,
          );
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents: stubs[args.path],
            loader: "js",
            resolveDir: process.cwd(),
          }));
        },
      },
    ],
  });
  return {
    Composer: createRequire(import.meta.url)(outfile).Composer as typeof Composer,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function installDom() {
  const stored = new Map<string, string>();
  const document = new DOMImplementation().createDocument(
    null,
    "html",
    null,
  ) as unknown as Document;
  const container = document.createElement("div");
  document.documentElement.appendChild(container);
  const prototype = Object.getPrototypeOf(container);
  prototype.addEventListener = prototype.removeEventListener = prototype.focus = () => {};
  prototype.getClientRects = () => [{}];
  prototype.closest = () => null;
  Object.defineProperty(prototype, "style", { configurable: true, get: () => ({}) });
  Object.defineProperty(prototype, "isConnected", { configurable: true, get: () => true });
  Object.defineProperty(document.documentElement, "dataset", { configurable: true, value: {} });
  document.addEventListener = document.removeEventListener = () => {};
  const window = {
    document,
    HTMLIFrameElement: class {},
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  };
  const values = {
    window,
    document,
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  return {
    container,
    restore() {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

type Handlers = Record<string, (event?: unknown) => unknown>;
function handlers(element: Element): Handlers {
  const key = Object.keys(element).find((key) => key.startsWith("__reactProps"));
  assert.ok(key, "React mounted props must exist");
  return (element as unknown as Record<string, Handlers>)[key];
}
function button(container: Element, label: string): Element {
  const found = Array.from(container.getElementsByTagName("button")).find(
    (element) => element.getAttribute("aria-label") === label,
  );
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
const image = (id: string): Attachment => ({
  id,
  kind: "image",
  name: `${id}.png`,
  mimeType: "image/png",
  size: 8 * 1024 * 1024,
  data: "AA==",
});
const text = (id: string): Attachment => ({
  id,
  kind: "text",
  name: `${id}.txt`,
  mimeType: "text/plain",
  size: 1,
  text: "x",
});

test("mounted established Composer blocks attachment intake until failed send restores its payload", async () => {
  const mounted = installDom();
  const calls = { picker: 0, drop: 0, clipboard: 0, arrayBuffer: 0 };
  let picked: Attachment[] = [];
  let browserEvent: (event: unknown) => void = () => {};
  const fixture = {
    api: {
      async pickAndRead() {
        calls.picker++;
        return { attachments: picked, skipped: 0 };
      },
      async readDroppedFiles() {
        calls.drop++;
        return [text("late-drop")];
      },
      async readClipboardImages() {
        calls.clipboard++;
        return [image("late-paste")];
      },
    },
    set browserEvent(callback: (event: unknown) => void) {
      browserEvent = callback;
    },
  };
  Object.assign(globalThis, { __composerAttachmentFixture: fixture });
  const loaded = await loadComposer();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(mounted.container);
  try {
    for (const original of [
      Array.from({ length: 20 }, (_, index) => text(`original-${index}`)),
      [image("original-1"), image("original-2")],
    ]) {
      picked = original;
      let rejectSend!: (error: Error) => void;
      let submitted: Attachment[] = [];
      let submittedText = "";
      const inputRef = React.createRef<HTMLTextAreaElement>();
      await React.act(async () =>
        root.render(
          <loaded.Composer
            key={original.length}
            chatId="established"
            ready
            hasMessages
            initialText="Try this"
            freezeWhileSending={false}
            workspace={
              { id: "workspace", name: "Workspace", permission: "ask" } as React.ComponentProps<
                typeof Composer
              >["workspace"]
            }
            inputRef={inputRef}
            isGenerating={false}
            onStop={() => {}}
            onSend={(value, attachments) => {
              submittedText = value;
              submitted = attachments;
              return new Promise<void>((_resolve, reject) => {
                rejectSend = reject;
              });
            }}
          />,
        ),
      );
      await React.act(async () => {
        await handlers(button(mounted.container, "Attach files or images")).onClick();
      });
      const stalePicker = handlers(button(mounted.container, "Attach files or images")).onClick;
      let pending: unknown;
      await React.act(async () => {
        pending = handlers(button(mounted.container, "Send message")).onClick();
      });
      assert.deepEqual(submitted, original);
      assert.equal(
        Array.from(mounted.container.getElementsByTagName("button")).filter((element) =>
          element.getAttribute("aria-label")?.startsWith("Remove original-"),
        ).length,
        0,
        "send optimistically clears attachments",
      );
      const before = { ...calls };
      picked = [image("late-picker")];
      await React.act(async () => {
        // The pre-render handler exercises the same-tick path even though the latest button is disabled.
        await stalePicker();
        const drop = Array.from(mounted.container.getElementsByTagName("div")).find(
          (element) => handlers(element).onDrop,
        );
        assert.ok(drop);
        handlers(drop).onDrop({ preventDefault() {}, dataTransfer: { files: [{}] } });
      });
      await React.act(async () => {
        handlers(mounted.container.getElementsByTagName("textarea")[0]).onPaste({
          preventDefault() {},
          clipboardData: {
            getData: () => "",
            items: [
              {
                kind: "file",
                type: "image/png",
                getAsFile: () => ({
                  size: 1,
                  type: "image/png",
                  async arrayBuffer() {
                    calls.arrayBuffer++;
                    return new ArrayBuffer(1);
                  },
                }),
              },
            ],
          },
        });
        browserEvent({
          type: "annotation",
          workspaceId: "workspace",
          annotation: {
            url: "http://localhost/",
            comment: "Late annotation",
            elements: [],
            regions: [],
            strokes: [],
          },
        });
      });
      await React.act(async () => {
        rejectSend(new Error("append rejected"));
        await pending;
      });
      const restored = Array.from(mounted.container.getElementsByTagName("button")).filter(
        (element) => element.getAttribute("aria-label")?.startsWith("Remove "),
      );
      assert.equal(
        restored.length,
        original.length,
        "failed send must restore within the original count/byte budget",
      );
      assert.deepEqual(
        calls,
        before,
        "pending send must not admit picker, drop, or clipboard reads",
      );
      assert.equal(mounted.container.textContent?.includes("Late annotation"), false);
      // A second send observes the restored payload, with no late attachment or annotation additions.
      await React.act(async () => {
        pending = handlers(button(mounted.container, "Send message")).onClick();
      });
      assert.deepEqual(submitted, original);
      assert.equal(
        submittedText,
        "Try this",
        "pending browser annotations cannot change the restored draft",
      );
      assert.equal(
        attachmentInlineBytesRemaining(submitted),
        attachmentInlineBytesRemaining(original),
      );
      await React.act(async () => {
        rejectSend(new Error("append rejected again"));
        await pending;
      });
      picked = [];
      await React.act(async () => {
        await handlers(button(mounted.container, "Attach files or images")).onClick();
      });
      // A full restored draft stays at its limit without entering IPC.
      assert.deepEqual(calls, before);
      await React.act(async () => {
        handlers(button(mounted.container, `Remove ${original[0].name}`)).onClick();
      });
      await React.act(async () => {
        await handlers(button(mounted.container, "Attach files or images")).onClick();
      });
      assert.equal(
        calls.picker,
        before.picker + 1,
        "attachment intake resumes after the send settles and space is available",
      );
    }
  } finally {
    await React.act(async () => root.unmount());
    await loaded.cleanup();
    mounted.restore();
    Reflect.deleteProperty(globalThis, "__composerAttachmentFixture");
  }
});
