// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "./composer";
import { TooltipProvider } from "./ui";
import { CommandSystemProvider } from "../lib/command-system";
import { loadComposerDraft, stageComposerText } from "../lib/composer-draft-store";
import { openLayer } from "../lib/layer-stack";
import type { Chat, ChatMessage } from "../lib/types";
import type { ComposerHistoryEntry } from "../lib/composer-history";
import { TEST_WORKSPACE, createTestQueryClient, settle } from "../lib/test-harness";

// ↑ in an empty message box opens the history popover, live-fills the composer
// with past prompts, and shows each prompt's paired reply. ↓ steps back down
// (and restores the empty draft past the newest entry), Esc closes and
// restores without stopping an active reply, Enter keeps the prompt in the box,
// and Alt+Enter triggers Edit in fork when the turn is eligible.

let queryClient: QueryClient;

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  createdAt: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, content, createdAt, ...extra } as ChatMessage;
}

const ANSWERED = [
  message("u1", "user", "Plan the release", 1_700_000_000_000),
  message("a1", "assistant", "Here is a full release plan.", 1_700_000_001_000),
  message("u2", "user", "Make it shorter", 1_700_000_060_000),
  message("a2", "assistant", "Shorter release plan ready.", 1_700_000_061_000),
];

function chat(messages: ChatMessage[], extra: Partial<Chat> = {}): Chat {
  return { id: "chat-1", title: "Release", messages, createdAt: 1, updatedAt: 4, ...extra } as unknown as Chat;
}

beforeEach(() => {
  localStorage.clear();
  installBotTestIpc({
    "workspaces:files": () => ({
      entries: [{ path: "README.md", name: "README.md", parentPath: "", depth: 0, kind: "file" }],
      truncated: false,
      skippedDirectories: 0,
    }),
  });
  queryClient = createTestQueryClient();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

interface MountOptions {
  generating?: boolean;
  historyEntries?: readonly ComposerHistoryEntry[];
  withFork?: boolean;
  slashPaletteBlocked?: boolean;
  slashSessionBlockedReason?: string;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

function buildComposer(
  sessionChat: Chat | undefined,
  options: MountOptions,
  forks: Array<[string, string]>,
  sends: string[],
  onStop: () => void,
) {
  const {
    generating = false,
    historyEntries,
    withFork = true,
    slashPaletteBlocked = false,
    slashSessionBlockedReason,
    inputRef,
  } = options;
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CommandSystemProvider>
          <Composer
            ready
            hasMessages
            chatId={sessionChat?.id ?? "bot:b1"}
            sessionChat={sessionChat}
            historyEntries={historyEntries}
            workspace={TEST_WORKSPACE}
            inputRef={inputRef}
            slashPaletteBlocked={slashPaletteBlocked}
            slashSessionBlockedReason={slashSessionBlockedReason}
            onRenameChat={() => undefined}
            onSend={async (text) => {
              sends.push(text);
            }}
            onStop={onStop}
            onForkChat={
              withFork
                ? async (messageId, position) => {
                    forks.push([messageId, position]);
                  }
                : undefined
            }
            isGenerating={generating}
          />
        </CommandSystemProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function mount(sessionChat: Chat | undefined, options: MountOptions = {}) {
  const forks: Array<[string, string]> = [];
  const sends: string[] = [];
  let stops = 0;
  const onStop = () => {
    stops += 1;
  };
  const view = render(buildComposer(sessionChat, options, forks, sends, onStop));
  return {
    forks,
    sends,
    stops: () => stops,
    unmount: view.unmount,
    rerender: (nextChat: Chat | undefined, nextOptions: MountOptions = options) =>
      view.rerender(buildComposer(nextChat, nextOptions, forks, sends, onStop)),
  };
}

async function press(target: Element, key: string, init: Record<string, unknown> = {}) {
  let result = true;
  await act(async () => {
    result = fireEvent.keyDown(target, { key, ...init });
  });
  return result;
}

async function change(target: HTMLTextAreaElement, value: string) {
  await act(async () => {
    fireEvent.change(target, { target: { value } });
  });
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const historyListbox = () => screen.queryByRole("listbox", { name: "Message history" });
const replyRegion = () => document.querySelector<HTMLElement>("[data-composer-history-reply]");

test("↑ opens history, live-fills past prompts with paired replies, places caret at end, and ↓ returns to empty", async () => {
  const inputRef = React.createRef<HTMLTextAreaElement | null>();
  const { forks } = mount(chat(ANSWERED), { inputRef });
  await settle();
  await act(async () => {
    box().focus();
  });

  await press(box(), "ArrowUp");
  await settle();
  assert.deepEqual(forks, [], "↑ browses history instead of immediately forking");
  assert.equal(box().value, "Make it shorter");
  assert.equal(inputRef.current?.selectionStart, "Make it shorter".length);
  assert.ok(historyListbox(), "history listbox is visible");
  assert.equal(box().getAttribute("aria-controls"), historyListbox()!.id);
  assert.match(replyRegion()?.textContent ?? "", /Previous reply/u);
  assert.match(replyRegion()?.textContent ?? "", /Shorter release plan ready\./u);

  const options = screen.getAllByRole("option");
  assert.equal(options.length, 2);
  assert.equal(options[1]!.getAttribute("aria-selected"), "true");
  assert.equal(box().getAttribute("aria-activedescendant"), options[1]!.id);

  // Hovering an older row must NOT hijack keyboard selection or desync the textarea.
  await act(async () => {
    fireEvent.pointerMove(options[0]!);
  });
  assert.equal(options[1]!.getAttribute("aria-selected"), "true");
  assert.equal(box().value, "Make it shorter");

  // Second ↑ steps to the older prompt and updates the paired reply preview.
  await press(box(), "ArrowUp");
  assert.equal(box().value, "Plan the release");
  assert.equal(options[0]!.getAttribute("aria-selected"), "true");
  assert.match(replyRegion()?.textContent ?? "", /Here is a full release plan\./u);

  // ↓ steps back to newest, then ↓ again closes history and restores empty draft.
  await press(box(), "ArrowDown");
  assert.equal(box().value, "Make it shorter");
  assert.ok(historyListbox());

  await press(box(), "ArrowDown");
  assert.equal(box().value, "");
  assert.equal(historyListbox(), null);
});

test("browsing history does not pollute localStorage draft until committed or detached", async () => {
  const { unmount } = mount(chat(ANSWERED));
  await settle();
  await act(async () => {
    box().focus();
  });

  // Open and step through history — localStorage stays empty.
  await press(box(), "ArrowUp");
  assert.equal(box().value, "Make it shorter");
  assert.equal(loadComposerDraft("chat-1").text, "");

  await press(box(), "ArrowUp");
  assert.equal(box().value, "Plan the release");
  assert.equal(loadComposerDraft("chat-1").text, "");

  // Escape leaves localStorage empty.
  await press(box(), "Escape");
  assert.equal(box().value, "");
  assert.equal(loadComposerDraft("chat-1").text, "");

  // Unmounting while browsing leaves localStorage empty.
  await press(box(), "ArrowUp");
  assert.equal(box().value, "Make it shorter");
  unmount();
  assert.equal(loadComposerDraft("chat-1").text, "");

  // Remounting, opening, and committing with Enter persists to localStorage.
  mount(chat(ANSWERED));
  await settle();
  await act(async () => {
    box().focus();
  });
  await press(box(), "ArrowUp");
  await press(box(), "Enter");
  assert.equal(loadComposerDraft("chat-1").text, "Make it shorter");
});

test("Escape closes history and restores empty draft without stopping an active reply", async () => {
  const { stops } = mount(chat(ANSWERED), { generating: true });
  await settle();
  await act(async () => {
    box().focus();
  });

  await press(box(), "ArrowUp");
  assert.equal(box().value, "Make it shorter");
  assert.ok(historyListbox());

  // First Escape closes history and restores empty box — does NOT stop generation.
  await press(box(), "Escape");
  await settle();
  assert.equal(historyListbox(), null);
  assert.equal(box().value, "");
  assert.equal(stops(), 0, "Escape dismissed history rather than stopping the running reply");

  // Second Escape on the now-empty box stops generation as usual.
  await press(box(), "Escape");
  assert.equal(stops(), 1);
});

test("Enter commits recalled prompt without sending; Alt+Enter forks settled turns unless session-blocked", async () => {
  const { forks, sends, rerender } = mount(chat(ANSWERED));
  await settle();
  await act(async () => {
    box().focus();
  });

  await press(box(), "ArrowUp");
  await press(box(), "ArrowUp");
  assert.equal(box().value, "Plan the release");

  // Plain Enter closes history and keeps the recalled prompt in the box.
  await press(box(), "Enter");
  assert.equal(historyListbox(), null);
  assert.equal(box().value, "Plan the release");
  assert.deepEqual(sends, [], "first Enter commits the recalled text for review/editing");

  // When slashSessionBlockedReason is set, Alt+Enter does not fork.
  await change(box(), "");
  rerender(chat(ANSWERED), { slashSessionBlockedReason: "Reload Aiden first." });
  await settle();
  await press(box(), "ArrowUp");
  await press(box(), "Enter", { altKey: true });
  assert.deepEqual(forks, []);
  assert.deepEqual(sends, []);

  // Once unblocked, Alt+Enter forks just before the highlighted prompt.
  rerender(chat(ANSWERED), { slashSessionBlockedReason: undefined });
  await settle();
  await press(box(), "Enter", { altKey: true });
  assert.deepEqual(forks, [["u2", "before"]]);
  assert.equal(historyListbox(), null);
  assert.equal(box().value, "");
});

test("caret keys (including Shift+↑, Meta+↑, PageUp) detach history; popover pointerDown preserves focus", async () => {
  mount(chat(ANSWERED));
  await settle();
  await act(async () => {
    box().focus();
  });

  for (const [key, init] of [
    ["ArrowLeft", {}],
    ["ArrowUp", { shiftKey: true }],
    ["ArrowUp", { metaKey: true }],
    ["PageUp", {}],
  ] as const) {
    await change(box(), "");
    await press(box(), "ArrowUp");
    assert.ok(historyListbox());
    await press(box(), key, init);
    assert.equal(historyListbox(), null, `${key} detaches history`);
    assert.equal(box().value, "Make it shorter");
  }

  // PointerDown on the popover root or reply footer prevents blur so history stays open.
  await change(box(), "");
  await press(box(), "ArrowUp");
  const popover = document.querySelector<HTMLElement>("[data-composer-history-popover]")!;
  let pointerDownNotCancelled = true;
  await act(async () => {
    pointerDownNotCancelled = fireEvent.pointerDown(replyRegion()!);
  });
  assert.equal(pointerDownNotCancelled, false, "pointerDown default prevented on reply preview");
  assert.ok(popover.isConnected && historyListbox(), "history stays open");

  // Clicking a row selects it directly and closes history.
  const firstOption = screen.getAllByRole("option")[0]!;
  await act(async () => {
    fireEvent.pointerDown(firstOption);
    fireEvent.click(firstOption);
  });
  assert.equal(historyListbox(), null);
  assert.equal(box().value, "Plan the release");
});

test("↑ is left alone with text, modifiers, IME composition, or an open overlay layer", async () => {
  mount(chat(ANSWERED));
  await settle();
  await change(box(), "first line");
  await settle();
  const event = await press(box(), "ArrowUp");
  assert.equal(event, true, "the caret moves instead");
  assert.equal(historyListbox(), null);

  await change(box(), "");
  await settle();
  await press(box(), "ArrowUp", { shiftKey: true });
  await press(box(), "ArrowUp", { altKey: true });
  await press(box(), "ArrowUp", { isComposing: true });
  assert.equal(historyListbox(), null);
  assert.equal(box().value, "");

  // An open overlay layer (e.g. a popover or modal) blocks ↑ from opening history.
  const layer = openLayer("popover", { name: "test-overlay" });
  try {
    await press(box(), "ArrowUp");
    assert.equal(historyListbox(), null);
    assert.equal(box().value, "");
  } finally {
    layer.close();
  }
});

test("Bot chats and unanswered prompts support ↑ history without offering Edit in fork", async () => {
  const botHistory: ComposerHistoryEntry[] = [
    {
      id: "b-u1",
      prompt: "Check the inbox",
      promptPreview: "Check the inbox",
      replyPreview: "3 unread messages found.",
      replyStatus: "answered",
    },
    {
      id: "b-u2",
      prompt: "Summarize the first one",
      promptPreview: "Summarize the first one",
      replyStatus: "pending",
    },
  ];
  const { forks, sends } = mount(undefined, { historyEntries: botHistory, withFork: false });
  await settle();
  await act(async () => {
    box().focus();
  });

  await press(box(), "ArrowUp");
  assert.equal(box().value, "Summarize the first one");
  assert.match(replyRegion()?.textContent ?? "", /Waiting for reply/u);
  assert.doesNotMatch(replyRegion()?.textContent ?? "", /edit in fork/u);

  // Alt+Enter does nothing without fork support and must not submit.
  await press(box(), "Enter", { altKey: true });
  assert.deepEqual(forks, []);
  assert.deepEqual(sends, []);

  // Stepping up shows the answered Bot turn and its reply.
  await press(box(), "ArrowUp");
  assert.equal(box().value, "Check the inbox");
  assert.match(replyRegion()?.textContent ?? "", /3 unread messages found\./u);
});

test("recalling a /command or @mention prompt suppresses both palettes during browsing, on commit, and on blur", async () => {
  const triggerChat = chat([
    message("u1", "user", "/compact", 1),
    message("a1", "assistant", "Compacted.", 2),
    message("u2", "user", "check @READ", 3),
    message("a2", "assistant", "Checked README.", 4),
  ]);
  mount(triggerChat);
  await settle();
  await act(async () => {
    box().focus();
  });

  // Browsing `@READ`: mention picker stays closed.
  await press(box(), "ArrowUp");
  assert.equal(box().value, "check @READ");
  assert.ok(historyListbox());
  assert.equal(screen.queryByRole("listbox", { name: "Workspace files" }), null);

  // Committing `@READ` with Enter keeps mention picker closed.
  await press(box(), "Enter");
  await settle();
  assert.equal(historyListbox(), null);
  assert.equal(box().value, "check @READ");
  assert.equal(screen.queryByRole("listbox", { name: "Workspace files" }), null);

  // Blurring while browsing `@READ` also keeps mention picker closed.
  await change(box(), "");
  await press(box(), "ArrowUp");
  await act(async () => {
    fireEvent.blur(box());
  });
  await settle();
  assert.equal(historyListbox(), null);
  assert.equal(box().value, "check @READ");
  assert.equal(screen.queryByRole("listbox", { name: "Workspace files" }), null);

  // Blurring while browsing `/compact` keeps slash palette closed.
  await change(box(), "");
  await act(async () => {
    box().focus();
  });
  await press(box(), "ArrowUp");
  await press(box(), "ArrowUp");
  assert.equal(box().value, "/compact");
  await act(async () => {
    fireEvent.blur(box());
  });
  await settle();
  assert.equal(historyListbox(), null);
  assert.equal(box().value, "/compact");
  assert.equal(screen.queryByRole("listbox", { name: "Slash commands" }), null);

  // The first typed edit of a recalled `/compact` leaves history and keeps the slash palette closed.
  await change(box(), "");
  await act(async () => {
    box().focus();
  });
  await press(box(), "ArrowUp");
  await press(box(), "ArrowUp");
  assert.equal(box().value, "/compact");
  await change(box(), "/compac");
  await settle();
  assert.equal(historyListbox(), null);
  assert.equal(box().value, "/compac");
  assert.equal(screen.queryByRole("listbox", { name: "Slash commands" }), null);

  // The same holds for a recalled `@READ` mention.
  await change(box(), "");
  await press(box(), "ArrowUp");
  assert.equal(box().value, "check @READ");
  await change(box(), "check @REA");
  await settle();
  assert.equal(historyListbox(), null);
  assert.equal(box().value, "check @REA");
  assert.equal(screen.queryByRole("listbox", { name: "Workspace files" }), null);
});

test("external staged text and slashPaletteBlocked cleanly unwind transient history browsing", async () => {
  const { rerender } = mount(chat(ANSWERED));
  await settle();
  await act(async () => {
    box().focus();
  });

  // External stageComposerText merges onto savedDraft (""), not onto browsed history prompt.
  await press(box(), "ArrowUp");
  assert.equal(box().value, "Make it shorter");
  await act(async () => {
    stageComposerText("chat-1", "Follow-up from visual", { notice: null });
  });
  await settle();
  assert.equal(historyListbox(), null);
  assert.equal(box().value, "Follow-up from visual");

  // slashPaletteBlocked (e.g. an approval card appearing) dismisses back to savedDraft ("").
  await change(box(), "");
  await press(box(), "ArrowUp");
  assert.equal(box().value, "Make it shorter");
  rerender(chat(ANSWERED), { slashPaletteBlocked: true });
  await settle();
  assert.equal(historyListbox(), null);
  assert.equal(box().value, "");
});
