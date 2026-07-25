import * as React from "react";
import { X } from "lucide-react";
import { invoke } from "../lib/ipc";

export function AssistantApp(): React.ReactElement {
  return (
    <div className="flex h-screen flex-col text-primary">
      <header
        className="flex h-11 shrink-0 items-center justify-between border-b border-separator px-3"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <span className="text-sm font-medium">Aiden</span>
        <button
          type="button"
          aria-label="Close Aiden"
          className="rounded-md p-1 text-tertiary transition-colors hover:bg-list-hover hover:text-primary"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          onClick={() => void invoke("assistant:hide-window")}
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="flex-1" />
    </div>
  );
}
