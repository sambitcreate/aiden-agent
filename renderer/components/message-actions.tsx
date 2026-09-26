// Response footer actions: the established copy action plus the optional
// read-aloud speaker for the latest eligible response. Selection stays
// group-hover/focus-within based so the row never shifts height.

import { CopyButton } from "./copy-button";
import { ReadAloudButton, type ReadAloudActionProps } from "./read-aloud-button";

interface MessageActionsProps {
  copyText: string;
  /** Present only on the tail of an eligible whole response. */
  readAloud?: ReadAloudActionProps;
  /** Streaming responses keep the action row mounted but invisible. */
  hidden?: boolean;
}

export function MessageActions({ copyText, readAloud, hidden }: MessageActionsProps) {
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
      {readAloud ? (
        <ReadAloudButton
          {...readAloud}
          className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[active=true]:opacity-100"
        />
      ) : null}
    </div>
  );
}
