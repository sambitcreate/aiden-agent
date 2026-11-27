// The stacked design layout's visible pane (Chat or Canvas). The layout owns
// the state; the top bar's switch, the chat body and the canvas's presence
// report read it. Kept apart from the layout so the canvas can read it
// without importing the layout.

import * as React from "react";

export type DesignPane = "chat" | "canvas";

/** The stacked layout's one visible pane, for the top bar's Chat | Canvas switch and the chat body. */
export interface DesignPaneState {
  /** True while design mode is on and the content is too narrow to split. */
  stacked: boolean;
  pane: DesignPane;
  setPane(pane: DesignPane): void;
}

export const DesignPaneContext = React.createContext<DesignPaneState>({
  stacked: false,
  pane: "chat",
  setPane: () => {},
});

/** The stacked design layout's visible pane; outside design mode the chat is always shown. */
export function useDesignPane(): DesignPaneState {
  return React.useContext(DesignPaneContext);
}

/** True while the stacked design layout shows the canvas, so the chat's body is hidden. */
export function useDesignChatBodyHidden(): boolean {
  const { stacked, pane } = useDesignPane();
  return stacked && pane === "canvas";
}

