// Reads an Electron `WebFrameMain` as the policy's `AppFrameRef`, lazily:
// every field is read when the policy asks for it, and a destroyed frame's
// read throws, which the policy and the registry treat as app context in the
// main window (fail closed).

import type { AppFrameRef } from "./app-network-policy.js";

export type FrameLike = {
  readonly frameTreeNodeId: number;
  readonly parent: FrameLike | null;
  readonly url: string;
  readonly origin: string;
  readonly name: string;
};

export type NamedFrameRef = AppFrameRef & { readonly name: string };

export function appFrameRef(frame: FrameLike, mainFrameId: number | null): NamedFrameRef {
  return {
    get frameTreeNodeId() {
      return frame.frameTreeNodeId;
    },
    get parent() {
      const parent = frame.parent;
      return parent ? appFrameRef(parent, mainFrameId) : null;
    },
    get url() {
      return frame.url;
    },
    get origin() {
      return frame.origin;
    },
    get name() {
      return frame.name;
    },
    get isMainFrame() {
      return mainFrameId !== null && frame.frameTreeNodeId === mainFrameId;
    },
  };
}

/** The main frame's id of a web contents, or null when it can't be read. */
export function mainFrameIdOf(contents: { mainFrame?: { frameTreeNodeId: number } } | null | undefined): number | null {
  try {
    const id = contents?.mainFrame?.frameTreeNodeId;
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}
