// A single chat message. User messages are right-aligned bubbles; assistant
// messages render markdown full-width, native-transcript style.

import * as React from "react";
import { Callout, ErrorBoundary, Text } from "./ui";
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

export interface MessageBubbleProps {
  imageScope?: string;
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
  imageScope,
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
        <div className="group flex justify-end">
          <div className="flex max-w-[80%] flex-col items-end gap-2">
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
          {content ? (
            <div className="select-text rounded-2xl bg-control px-4 py-2.5">
              <UserMessageContent content={content} />
            </div>
          ) : null}
          {content || fork ? (
            <div className="flex items-center gap-0.5">
              {fork ? (
                <ForkMessageButton
                  action={fork}
                  kind="edit"
                  className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                />
              ) : null}
              {content ? (
                <CopyButton
                  text={content}
                  label="Copy message"
                  className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                />
              ) : null}
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
            imageScope={imageScope}
            content={content}
            // Text that settled or whose turn ended shows in full in the same
            // tree; text a tool step closed still joins at the next release.
            complete={streaming ? Boolean(streamComplete) : true}
            closed={Boolean(streaming && textClosed)}
            onHandoffComplete={streamComplete ? onStreamHandoffComplete : undefined}
            richLinks
          />
        ) : (
          <Markdown content={content} richLinks imageScope={imageScope} />
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

function UserMessageContent({ content }: { content: string }) {
  const segments = tokenizeWebLinks(content);
  let richLinkCount = 0;
  return (
    <Text className="whitespace-pre-wrap break-words">
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
