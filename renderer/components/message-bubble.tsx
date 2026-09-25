// A single chat message. User messages are right-aligned bubbles; assistant
// messages render markdown full-width, native-transcript style.

import { Callout, ErrorBoundary, Text } from "./ui";
import { AidenIcon } from "./aiden-icon";
import { Markdown } from "./markdown";
import { StreamingMarkdownReveal } from "./streaming-markdown-reveal";
import { CopyButton } from "./copy-button";
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
  role: ChatMessage["role"];
  content: string;
  attachments?: Attachment[];
  skill?: SkillProvenanceV1;
  /** Render the assistant reply through the stable streaming reveal path. */
  streaming?: boolean;
  streamComplete?: boolean;
  onStreamHandoffComplete?: () => void;
  /** Split assistant prose renders one whole-response copy action on its tail. */
  showCopy?: boolean;
  copyText?: string;
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
  onStreamHandoffComplete,
  showCopy = true,
  copyText,
}: MessageBubbleProps) {
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
              <AidenIcon aria-hidden="true" className="size-3.5 shrink-0 text-accent" />
              <span className="truncate font-medium text-primary">{skill.name}</span>
              <span className="text-mini capitalize text-tertiary">{skill.source}</span>
            </div>
          ) : null}
          {attachments && attachments.length > 0 ? (
            <MessageAttachments attachments={attachments} role="user" />
          ) : null}
          {content ? (
            <div className="rounded-2xl bg-control px-4 py-2.5">
              <UserMessageContent content={content} />
            </div>
          ) : null}
          {content ? (
            <CopyButton
              text={content}
              label="Copy message"
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            />
          ) : null}
          </div>
        </div>
      </RichLinkBudget>
    );
  }

  return (
    <RichLinkBudget
      key={streaming ? "streaming" : "settled"}
      limit={MAX_RICH_LINKS_PER_MESSAGE}
    >
      <div className="group flex w-full">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
        {attachments && attachments.length > 0 ? (
          <MessageAttachments attachments={attachments} role="assistant" />
        ) : null}
        {streaming ? (
          <StreamingMarkdownReveal
            content={content}
            complete={streamComplete}
            onHandoffComplete={onStreamHandoffComplete}
            richLinks
          />
        ) : (
          <Markdown content={content} richLinks />
        )}
        {content && showCopy ? (
          <div
            className={`mt-1 ${streaming && !streamComplete ? "invisible" : ""}`}
            aria-hidden={streaming && !streamComplete}
          >
            <CopyButton
              text={copyText ?? content}
              label="Copy message"
              className="-ml-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            />
          </div>
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
              className="text-accent underline underline-offset-2"
            >
              {segment.text}
            </RichLink>
          );
        }
        return (
          <a
            key={key}
            href={segment.href}
            className="rounded-[2px] text-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
      <Text variant="small" color="secondary" className="mt-0.5 block whitespace-pre-wrap">
        {content}
      </Text>
    </Callout>
  );
}
