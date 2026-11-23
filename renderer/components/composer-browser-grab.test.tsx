// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { Composer } from "./composer";
import { TooltipProvider } from "./ui";
import { CommandSystemProvider } from "../lib/command-system";
import { browserElementGrabDelivery } from "../lib/browser-element-grab-delivery";
import {
  discardComposerDraft,
  loadComposerDraftGrabbedElements,
  restoreUnsentMessage,
  seedComposerAttachments,
  seedComposerGrabbedElements,
} from "../lib/composer-draft-store";
import {
  GRABBED_ELEMENT_SCHEMA_VERSION,
  grabbedElementThumbnailId,
  type GrabbedElementCapture,
  type GrabbedElementContextV1,
} from "../shared/browser-element-grab";
import type { Attachment, Chat, Workspace } from "../lib/types";

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";

const WORKSPACE: Workspace = {
  id: "ws-grab",
  name: "app",
  folderPath: "/tmp/app",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
};

interface SendCall {
  kind: "send" | "queue" | "steer";
  text: string;
  attachments: Attachment[];
  grabbedElements?: GrabbedElementContextV1[];
  btw?: boolean;
}

let queryClient: QueryClient;
let calls: SendCall[];
let rejectSend: Error | null;
let chatCounter = 0;

function nextChatId(): string {
  chatCounter += 1;
  return `chat-grab-${chatCounter}`;
}

function makeCapture(
  overrides: Partial<GrabbedElementContextV1> = {},
  options: { withThumbnail?: boolean; keepActive?: boolean } = {},
): GrabbedElementCapture {
  const id = overrides.id ?? "el-hero";
  const withThumbnail = options.withThumbnail !== false;
  return {
    element: {
      version: GRABBED_ELEMENT_SCHEMA_VERSION,
      id,
      label: "<LandingHeroClient />",
      framework: "react",
      componentName: "LandingHeroClient",
      tagName: "section",
      selector: "main > section.hero",
      htmlSnippet: '<section class="hero"><h1>Hero</h1></section>',
      boundingBox: { x: 10, y: 20, width: 640, height: 240 },
      pageUrl: "http://localhost:3000/",
      capturedAt: 1700000000000,
      ...overrides,
    },
    ...(withThumbnail
      ? {
          thumbnail: {
            data: ONE_PIXEL_PNG_B64,
            mimeType: "image/png" as const,
            width: 320,
            height: 120,
          },
        }
      : {}),
    ...(options.keepActive !== undefined ? { keepActive: options.keepActive } : {}),
  };
}

beforeEach(() => {
  localStorage.clear();
  calls = [];
  rejectSend = null;
  installBotTestIpc({
    "pullRequests:list": () => ({ links: [] }),
    "pullRequests:current": () => null,
    "pullRequests:pending": () => [],
    "workspaces:repositoryIdentity": () => null,
    "workspaces:files": () => ({ entries: [], truncated: false, skippedDirectories: 0 }),
    "settings:get": () => null,
    "shortcut:get": () => null,
    "app:renderer-ready": () => null,
    "skills:discover": () => [],
    "providers:list": () => [],
    "live:state": () => ({ offered: false, sessionActive: false, needsSetup: false }),
    "followThrough:list": () => ({ checks: [], pullRequests: [] }),
    "design:mode:get": () => null,
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

async function mountComposer(props: {
  chatId?: string;
  visionSupported?: boolean;
  isGenerating?: boolean;
  firstMessageSaving?: boolean;
  withQueueAndSteer?: boolean;
} = {}) {
  const chatId = props.chatId ?? nextChatId();
  const chat = {
    id: chatId,
    title: "Grab test chat",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Chat;
  const inputRef = React.createRef<HTMLTextAreaElement>();
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <CommandSystemProvider>
            <Composer
              ready
              hasMessages
              chatId={chatId}
              sessionChat={chat}
              workspace={WORKSPACE}
              inputRef={inputRef}
              visionSupported={props.visionSupported}
              isGenerating={props.isGenerating ?? false}
              firstMessageSaving={props.firstMessageSaving ?? false}
              onRenameChat={() => undefined}
              onSend={async (text, attachments, _skill, options) => {
                calls.push({
                  kind: "send",
                  text,
                  attachments,
                  grabbedElements: options?.grabbedElements,
                  btw: options?.btw,
                });
                if (rejectSend) throw rejectSend;
              }}
              onQueue={
                props.withQueueAndSteer
                  ? async (text, attachments, _skill, options) => {
                      calls.push({
                        kind: "queue",
                        text,
                        attachments,
                        grabbedElements: options?.grabbedElements,
                      });
                      if (rejectSend) throw rejectSend;
                    }
                  : undefined
              }
              onSteer={
                props.withQueueAndSteer
                  ? async (text, attachments, _skill, options) => {
                      calls.push({
                        kind: "steer",
                        text,
                        attachments,
                        grabbedElements: options?.grabbedElements,
                      });
                      if (rejectSend) throw rejectSend;
                    }
                  : undefined
              }
              onStop={() => undefined}
            />
          </CommandSystemProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  const textarea = rendered.container.querySelector("textarea")!;
  // Happy-dom returns empty client rects; stub one so Composer's visibility fence passes.
  textarea.getClientRects = () => [new DOMRect(0, 0, 200, 32)] as unknown as DOMRectList;
  return { chatId, inputRef, textarea, ...rendered };
}

function deliverGrab(capture: GrabbedElementCapture): boolean {
  return browserElementGrabDelivery.capture(WORKSPACE.id)?.deliver(capture) ?? false;
}

test("delivers grabbed element chip, deduplicates in place, hides raw thumbnail card, and sends with empty text", async () => {
  const { chatId, container } = await mountComposer();

  let delivered = false;
  await act(async () => {
    delivered = deliverGrab(makeCapture({ id: "el-1" }));
  });
  assert.equal(delivered, true);

  // Chip renders once; linked grab-thumb_* is NOT duplicated in the generic attachment strip.
  assert.equal(container.querySelectorAll("[data-grabbed-element-chip]").length, 1);
  assert.equal(screen.queryByRole("button", { name: "Remove LandingHeroClient.png" }), null);

  // Re-grabbing same element dedup key refreshes in place instead of duplicating.
  await act(async () => {
    delivered = deliverGrab(
      makeCapture({ id: "el-2", htmlSnippet: '<section class="hero updated"></section>' }),
    );
  });
  assert.equal(delivered, true);
  assert.equal(container.querySelectorAll("[data-grabbed-element-chip]").length, 1);
  assert.ok(container.querySelector('[data-grabbed-element-chip="el-2"]'));

  // Empty-text send is allowed and includes both grabbedElements and linked thumbnail attachment.
  const sendButton = screen.getByRole("button", { name: "Send message" });
  assert.equal((sendButton as HTMLButtonElement).disabled, false);
  await act(async () => {
    fireEvent.click(sendButton);
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.text, "");
  assert.equal(calls[0]!.grabbedElements?.length, 1);
  assert.equal(calls[0]!.grabbedElements?.[0]?.id, "el-2");
  assert.equal(calls[0]!.attachments.length, 1);
  assert.equal(calls[0]!.attachments[0]?.id, grabbedElementThumbnailId("el-2"));
  assert.equal(loadComposerDraftGrabbedElements(chatId).length, 0, "in-memory draft clears on send");
});

test("text-only models show non-blocking note and still allow sending grabbed elements", async () => {
  await mountComposer({ visionSupported: false });

  await act(async () => {
    deliverGrab(makeCapture({ id: "el-text-only" }));
  });

  assert.ok(screen.getByText("Text context only for this model"));
  const sendButton = screen.getByRole("button", { name: "Send message" });
  assert.equal((sendButton as HTMLButtonElement).disabled, false);

  await act(async () => {
    fireEvent.click(sendButton);
  });

  assert.equal(calls.length, 1, "text-only model sends grabbed element without blocking");
  assert.equal(calls[0]!.grabbedElements?.[0]?.id, "el-text-only");
});

test("delivery fence rejects grabs while firstMessageSaving is active", async () => {
  await mountComposer({ firstMessageSaving: true });

  let delivered = true;
  await act(async () => {
    delivered = deliverGrab(makeCapture({ id: "el-blocked" }));
  });
  assert.equal(delivered, false, "delivery fence blocks grab during first-message save");
});

test("Backspace at caret offset 0 removes last grabbed chip and its linked thumbnail", async () => {
  const { container, textarea } = await mountComposer();

  await act(async () => {
    deliverGrab(
      makeCapture({ id: "el-a", label: "<CardA />", selector: ".a", componentName: "CardA" }),
    );
    deliverGrab(
      makeCapture({ id: "el-b", label: "<CardB />", selector: ".b", componentName: "CardB" }),
    );
  });
  assert.equal(container.querySelectorAll("[data-grabbed-element-chip]").length, 2);

  textarea.selectionStart = 0;
  textarea.selectionEnd = 0;
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "Backspace" });
  });
  assert.equal(container.querySelectorAll("[data-grabbed-element-chip]").length, 1);
  assert.ok(container.querySelector('[data-grabbed-element-chip="el-a"]'));

  // Sending confirms el-b's thumbnail was removed along with el-b.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0]!.attachments.map((a) => a.id),
    [grabbedElementThumbnailId("el-a")],
  );
});

test("failed send restores grabbed elements and linked thumbnails; localStorage never stores them", async () => {
  const { chatId, container, textarea } = await mountComposer();
  rejectSend = new Error("network down");

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "Fix padding" } });
    deliverGrab(makeCapture({ id: "el-retry" }));
  });

  // Ensure localStorage has zero base64 or grabbed element metadata.
  const rawStored = localStorage.getItem(`aiden:composer-draft:${chatId}`) ?? "";
  assert.equal(rawStored.includes(ONE_PIXEL_PNG_B64), false);
  assert.equal(rawStored.includes("el-retry"), false);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  });

  assert.equal(calls.length, 1);
  assert.equal(textarea.value, "Fix padding", "draft text restored");
  assert.ok(container.querySelector('[data-grabbed-element-chip="el-retry"]'), "chip restored on failure");

  // Retry succeeds and still carries the restored element + thumbnail.
  rejectSend = null;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.grabbedElements?.[0]?.id, "el-retry");
  assert.equal(calls[1]!.attachments[0]?.id, grabbedElementThumbnailId("el-retry"));
});

test("grabbed elements disable Steer when generating and block /btw side questions", async () => {
  const { textarea } = await mountComposer({ isGenerating: true, withQueueAndSteer: true });

  await act(async () => {
    deliverGrab(makeCapture({ id: "el-busy" }));
    fireEvent.change(textarea, { target: { value: "Update header" } });
  });

  // Submitting while generating with a grabbed element queues rather than steering.
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "Enter" });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.kind, "queue", "busy send queues instead of steering when grabbed elements attached");
  assert.equal(calls[0]!.grabbedElements?.[0]?.id, "el-busy");

  // /btw is blocked when grabbed elements are attached.
  await act(async () => {
    deliverGrab(makeCapture({ id: "el-btw" }));
    fireEvent.change(textarea, { target: { value: "/btw why is this misaligned?" } });
  });
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "Enter" });
  });
  assert.equal(calls.length, 1, "/btw did not send while grabbed element attached");
});

test("Edit-in-Fork seeds and cancelled-worktree restore repopulate grabbed chips and thumbnails", async () => {
  const chatId = nextChatId();
  const element = makeCapture({ id: "el-fork" }).element;
  element.thumbnailAttachmentId = grabbedElementThumbnailId("el-fork");
  const thumb: Attachment = {
    id: grabbedElementThumbnailId("el-fork"),
    name: "LandingHeroClient.png",
    kind: "image",
    mimeType: "image/png",
    size: 68,
    data: ONE_PIXEL_PNG_B64,
  };
  seedComposerAttachments(chatId, [thumb]);
  seedComposerGrabbedElements(chatId, [element]);

  const { container } = await mountComposer({ chatId });
  assert.ok(container.querySelector('[data-grabbed-element-chip="el-fork"]'), "forked chip mounts");

  // Restore unsent message (e.g. cancelled worktree send) into mounted composer.
  const restoredEl = makeCapture({ id: "el-worktree", label: "<Footer />", selector: "footer", componentName: "Footer" }).element;
  restoredEl.thumbnailAttachmentId = grabbedElementThumbnailId("el-worktree");
  const restoredThumb: Attachment = {
    ...thumb,
    id: grabbedElementThumbnailId("el-worktree"),
    name: "Footer.png",
  };
  await act(async () => {
    restoreUnsentMessage(chatId, "Keep footer sticky", [restoredThumb], [restoredEl]);
  });
  assert.ok(container.querySelector('[data-grabbed-element-chip="el-worktree"]'));
  discardComposerDraft(chatId);
});
