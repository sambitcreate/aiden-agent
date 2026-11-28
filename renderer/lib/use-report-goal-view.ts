import * as React from "react";
import { chatsApi } from "./ipc";

/**
 * Tell main which local workspace chat this window shows, for keep-going rounds
 * on screen. Main starts a due round in a focused window showing its chat, so
 * the round can use the browser and Computer Use; showing another chat stops a
 * round this window owns.
 *
 * Every conversation view calls this. `null` means the view shows a
 * conversation that is not a local workspace chat (a new chat, a Bot, a chat on
 * a paired host): a round this window owns elsewhere stops. Leaving a chat for
 * Settings or another page that is not a conversation keeps the round (the
 * window shows no other chat); it just isn't offered new ones.
 */
export function useReportGoalView(chatId: string | null): void {
  React.useEffect(() => {
    if (chatId === null) {
      void chatsApi.reportGoalView(null, document.hasFocus()).catch(() => undefined);
      return;
    }
    const report = () =>
      void chatsApi.reportGoalView(chatId, document.hasFocus()).catch(() => undefined);
    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      void chatsApi.reportGoalView(chatId, false).catch(() => undefined);
    };
  }, [chatId]);
}
