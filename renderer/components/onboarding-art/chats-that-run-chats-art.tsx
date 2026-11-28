import { MessageSquare, MessagesSquare } from "lucide-react";
import { ArtChip, ArtComposer, ArtIcon, ArtWindow, Bar } from "./art-kit";

const STARTED = [
  { state: "working", label: "Working", width: "78%" },
  { state: "needs", label: "Needs you", width: "64%" },
  { state: "done", label: "Done", width: "86%" },
] as const;

/**
 * A lead chat's "3 chats working" chip and its list: one chat working, one
 * waiting for the person's approval and one done, as the shipped popover shows them.
 */
export function ChatsThatRunChatsArt() {
  return (
    <>
      <ArtWindow
        className="oa-schat"
        style={{ left: 10, top: 10, width: 176, height: "calc(100% + 20px)", minHeight: 260 }}
      >
        <div className="oa-schat-head oa-separator-bottom">
          <ArtIcon icon={MessageSquare} />
          <Bar width={58} tone="ink" />
        </div>
        <div className="oa-schat-chat">
          <div className="oa-schat-bubble">
            <Bar width="100%" />
            <Bar width="48%" />
          </div>
          <div className="oa-schat-reply">
            <Bar width="90%" tone="ink" />
            <Bar width="70%" />
          </div>
        </div>
        <div className="oa-schat-foot">
          <div className="oa-row oa-schat-chips">
            <ArtChip
              icon={MessagesSquare}
              className="oa-anim-pop"
              style={{ animationDelay: "0.3s" }}
            >
              3 chats working
            </ArtChip>
          </div>
          <ArtComposer style={{ position: "relative" }} />
        </div>
      </ArtWindow>
      <ArtWindow
        raised
        className="oa-sched"
        style={{ left: 110, top: 34, width: 168, padding: "9px 7px" }}
      >
        <div className="oa-sched-title">
          <ArtIcon icon={MessagesSquare} /> Started chats
        </div>
        <div className="oa-sched-list" role="list" aria-label="Started chats">
          {STARTED.map((chat, index) => (
            <div
              key={chat.state}
              className="oa-sched-row oa-anim-pop"
              role="listitem"
              style={{ animationDelay: `${0.6 + index * 0.25}s` }}
            >
              <span className="oa-sched-dot" data-chat-state={chat.state} />
              <span className="oa-sched-text">
                <Bar width={chat.width} tone="ink" />
                <span>{chat.label}</span>
              </span>
            </div>
          ))}
        </div>
      </ArtWindow>
    </>
  );
}
