// A single chat message. User messages are right-aligned bubbles; assistant
// messages render markdown full-width, native-transcript style.

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Button, Callout, ErrorBoundary, Text } from "./ui";
import { AidenIcon } from "./aiden-icon";
import { Markdown } from "./markdown";
import { StreamingMarkdownReveal } from "./streaming-markdown-reveal";
import { CopyButton } from "./copy-button";
import { MessageActions } from "./message-actions";
import { ForkMessageButton, type MessageForkAction } from "./fork-message-button";
import type { ReadAloudActionProps } from "./read-aloud-button";
import type { Attachment, ChatMessage } from "../lib/types";
import type { SkillProvenanceV1 } from "../shared/slash-commands";
import { MessageAttachments } from "./message-attachments";
import {
  describeRichLink,
  MAX_RICH_LINKS_PER_MESSAGE,
  tokenizeWebLinks,
} from "../lib/rich-link";
import { RichLink, RichLinkBudget } from "./rich-link";
import { cn } from "../lib/ui-utils";
import { USER_MESSAGE_FOLD_LINES, userMessageFolds, userMessageMayFold } from "../lib/user-message-fold";

export interface MessageBubbleProps {
  role: ChatMessage["role"];
  content: string;
  attachments?: Attachment[];
  skill?: SkillProvenanceV1;
  /** Render the assistant reply through the stable streaming reveal path. */
  streaming?: boolean;
  streamComplete?: boolean;
  /** A later step has closed this text: it can no longer grow, though the turn runs on. */
  textClosed?: boolean;
  onStreamHandoffComplete?: () => void;
  /** Split assistant prose renders one whole-response copy action on its tail. */
  showCopy?: boolean;
  copyText?: string;
  /** Read-aloud action for the latest eligible whole response. */
  readAloud?: ReadAloudActionProps;
  /** Settled turn facts rendered at the trailing edge of the action row. */
  footer?: React.ReactNode;
  /** Fork from a settled reply, or edit a sent prompt in a fork. */
  fork?: MessageForkAction;
}

/** Isolate untrusted model-formatting failures to the individual message. */
export function SafeMessageBubble(props: MessageBubbleProps) {
  return (
    <ErrorBoundary
      fallback={<UnrenderableMessage content={props.content} />}
      resetKey={props.content}
    >
      <MessageBubble {...props} />
    </ErrorBoundary>
  );
}

export function MessageBubble({
  role,
  content,
  attachments,
  skill,
  streaming,
  streamComplete,
  textClosed,
  onStreamHandoffComplete,
  showCopy = true,
  copyText,
  readAloud,
  footer,
  fork,
}: MessageBubbleProps) {
  // A reply first drawn while streaming keeps that one Markdown tree after it
  // settles, so its blocks, code, and links stay the same elements.
  const [revealed, setRevealed] = React.useState(Boolean(streaming));
  if (streaming && !revealed) setRevealed(true);

  if (role === "user") {
    return (
      <RichLinkBudget limit={MAX_RICH_LINKS_PER_MESSAGE}>
        <div className="flex justify-end">
          <div className="group flex min-w-0 max-w-[80%] flex-col items-end gap-2">
          {skill ? (
            <div
              className="flex max-w-full items-center gap-1.5 rounded-lg bg-status-accent-surface px-2 py-1 text-small text-secondary"
              aria-label={`${skill.name}, ${skill.source} skill`}
            >
              <AidenIcon aria-hidden="true" className="size-3.5 shrink-0 text-accent-text" />
              <span className="truncate font-medium text-primary">{skill.name}</span>
              <span className="text-mini capitalize text-tertiary">{skill.source}</span>
            </div>
          ) : null}
          {attachments && attachments.length > 0 ? (
            <MessageAttachments attachments={attachments} role="user" />
          ) : null}
          {content ? <UserMessageBody content={content} showCopy={showCopy} /> : null}
          {fork ? (
            <div className="flex items-center gap-0.5">
              <ForkMessageButton
                action={fork}
                kind="edit"
                className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              />
            </div>
          ) : null}
          </div>
        </div>
      </RichLinkBudget>
    );
  }

  return (
    <RichLinkBudget limit={MAX_RICH_LINKS_PER_MESSAGE}>
      <div className="group flex w-full">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
        {attachments && attachments.length > 0 ? (
          <MessageAttachments attachments={attachments} role="assistant" />
        ) : null}
        {revealed ? (
          <StreamingMarkdownReveal
            content={content}
            // Text that settled or whose turn ended shows in full in the same
            // tree; text a tool step closed still joins at the next release.
            complete={streaming ? Boolean(streamComplete) : true}
            closed={Boolean(streaming && textClosed)}
            onHandoffComplete={streamComplete ? onStreamHandoffComplete : undefined}
            richLinks
          />
        ) : (
          <Markdown content={content} richLinks />
        )}
        {content && showCopy ? (
          <MessageActions
            copyText={copyText ?? content}
            readAloud={readAloud}
            hidden={Boolean(streaming && !streamComplete)}
            footer={footer}
            fork={streaming ? undefined : fork}
          />
        ) : null}
        </div>
      </div>
    </RichLinkBudget>
  );
}

/**
 * The sent prompt's bubble. A long prompt folds to a few lines with a chevron
 * that shows the rest, and hovering the bubble offers a copy of the full text
 * at its top-right corner. Folding never hides text from selection, Find, or
 * assistive technology: the whole prompt stays in the DOM.
 */
function UserMessageBody({ content, showCopy }: { content: string; showCopy: boolean }) {
  const bodyId = React.useId();
  const bubbleRef = React.useRef<HTMLDivElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const [foldable, setFoldable] = React.useState(() => userMessageMayFold(content));
  const [expanded, setExpanded] = React.useState(false);
  const restoreAfterCollapseRef = React.useRef(false);
  const folded = foldable && !expanded;

  // Measure the wrapped height once the row lays out, and again whenever its
  // width changes. A row whose layout the transcript defers reports nothing
  // until it nears the viewport, so the first-paint guess holds until then.
  React.useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const lineHeight = Number.parseFloat(getComputedStyle(body).lineHeight);
      setFoldable(userMessageFolds(body.scrollHeight, lineHeight));
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [content]);

  // Collapsing a prompt read from below its top would leave the reader where
  // its hidden tail used to be, so bring its top back into view.
  React.useLayoutEffect(() => {
    if (expanded || !restoreAfterCollapseRef.current) return;
    restoreAfterCollapseRef.current = false;
    bubbleRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [expanded]);

  const toggle = () => {
    if (expanded) {
      const bubble = bubbleRef.current;
      const scroller = bubble?.closest("[data-scroll-top]");
      restoreAfterCollapseRef.current = Boolean(
        bubble && scroller && bubble.getBoundingClientRect().top < scroller.getBoundingClientRect().top,
      );
    }
    setExpanded((open) => !open);
  };

  return (
    <div
      ref={bubbleRef}
      data-user-message-bubble
      className="user-message-bubble group/bubble relative max-w-full select-text rounded-2xl bg-control px-4 py-2.5"
    >
      <div
        ref={bodyRef}
        id={bodyId}
        // The fold measures in this element's own line height (`lh`).
        className="user-message-fold text-regular"
        data-foldable={foldable ? "true" : undefined}
        data-folded={folded ? "true" : undefined}
        style={{ "--user-message-fold-lines": USER_MESSAGE_FOLD_LINES } as React.CSSProperties}
        // Tabbing to a link in the hidden tail shows the whole prompt.
        onFocus={folded ? () => setExpanded(true) : undefined}
      >
        <UserMessageContent content={content} />
      </div>
      {foldable ? (
        <div className="-mr-2 -mb-1.5 flex justify-end">
          <Button
            variant="transparent"
            size="small"
            iconOnly
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-label={expanded ? "Show less" : "Show full message"}
            title={expanded ? "Show less" : "Show full message"}
            data-user-message-fold-toggle
            className="size-6 text-tertiary hover:text-secondary"
            onClick={toggle}
          >
            <ChevronDown
              aria-hidden="true"
              className={cn("size-3.5 transition-transform duration-150 ease-out", expanded && "rotate-180")}
            />
          </Button>
        </div>
      ) : null}
      {showCopy ? (
        <CopyButton
          text={content}
          label="Copy message"
          className="absolute right-1.5 top-1.5 bg-popover/95 text-secondary opacity-0 shadow-popover transition-opacity group-hover/bubble:opacity-100 group-focus-within/bubble:opacity-100 focus-visible:opacity-100"
        />
      ) : null}
    </div>
  );
}

function UserMessageContent({ content }: { content: string }) {
  const segments = tokenizeWebLinks(content);
  let richLinkCount = 0;
  return (
    // `anywhere`, not `break-word`: only it lets an unbroken token (a key, hash,
    // or URL) shrink the bubble's min-content width, so a right-aligned bubble
    // wraps inside its column instead of spilling left under the sidebar.
    <Text className="whitespace-pre-wrap [overflow-wrap:anywhere]">
      {segments.map((segment) => {
        if (segment.kind === "text") return segment.text;
        const descriptor = describeRichLink(segment.href);
        const canRenderRichLink = Boolean(
          descriptor && richLinkCount < MAX_RICH_LINKS_PER_MESSAGE,
        );
        if (canRenderRichLink) richLinkCount += 1;
        const key = `${segment.start}:${segment.end}`;
        if (descriptor && canRenderRichLink) {
          return (
            <RichLink
              key={key}
              href={segment.href}
              descriptor={descriptor}
              className="text-accent-text underline underline-offset-2"
            >
              {segment.text}
            </RichLink>
          );
        }
        return (
          <a
            key={key}
            href={segment.href}
            className="rounded-[2px] text-accent-text underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {segment.text}
          </a>
        );
      })}
    </Text>
  );
}

// Markdown, KaTeX, and highlighting all run over untrusted model output. If one
// message throws, keep the rest of the transcript alive and show its raw text.
function UnrenderableMessage({ content }: { content: string }) {
  return (
    <Callout color="red">
      <Text variant="small-strong" color="red">
        This message could not be formatted
      </Text>
      <Text variant="small" color="secondary" className="mt-0.5 block select-text whitespace-pre-wrap">
        {content}
      </Text>
    </Callout>
  );
}
