// Response footer actions: the established copy action plus the optional
// read-aloud speaker for the latest eligible response. Selection stays
// group-hover/focus-within based so the row never shifts height.

import type * as React from "react";
import { CopyButton } from "./copy-button";
import { ForkMessageButton, type MessageForkAction } from "./fork-message-button";
import { ReadAloudButton, type ReadAloudActionProps } from "./read-aloud-button";

interface MessageActionsProps {
  copyText: string;
  /** Present only on the tail of an eligible whole response. */
  readAloud?: ReadAloudActionProps;
  /** Streaming responses keep the action row mounted but invisible. */
  hidden?: boolean;
  /** Always-visible trailing turn facts; they share the row so it never grows. */
  footer?: React.ReactNode;
  /** Present on settled replies that can start a fork. */
  fork?: MessageForkAction;
}

export function MessageActions({ copyText, readAloud, hidden, footer, fork }: MessageActionsProps) {
  return (
    <div
      className={`group/actions mt-1 flex items-center gap-0.5 ${hidden ? "invisible" : ""}`}
      aria-hidden={hidden}
    >
      <CopyButton
        text={copyText}
        label="Copy message"
        className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
      />
      {fork ? (
        <ForkMessageButton
          action={fork}
          kind="fork"
          className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        />
      ) : null}
      {readAloud ? (
        <ReadAloudButton
          {...readAloud}
          className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[active=true]:opacity-100"
        />
      ) : null}
      {footer ? <div className="ml-auto flex min-w-0 justify-end pl-3">{footer}</div> : null}
    </div>
  );
}
