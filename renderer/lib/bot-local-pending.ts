/** Only a successful delete or the host's explicit deletion receipt may erase pending changes. */
const deletedKey = (botId: string) => `aiden:deleted-bot-pending:${encodeURIComponent(botId)}`;
export function assertBotCanSavePendingChanges(botId: string): void {
  if (localStorage.getItem(deletedKey(botId))) throw new Error("This Bot was deleted. Its saved changes cannot be sent again.");
}
export function forgetBotPendingChanges(botId: string): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    const encoded = encodeURIComponent(botId), names: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index);
      if (name && (name === `aiden:pending-connector-watch:${botId}` || name.startsWith(`aiden:open-work:pending:${encoded}:`) || name.startsWith(`aiden:routine-model:pending:${encoded}:`) || name.startsWith(`aiden:bot-resume:pending:${encoded}:`))) names.push(name);
    }
    for (const name of names) localStorage.removeItem(name);
    // Deleted Bot IDs are never reused. A late callback cannot recreate its journal.
    localStorage.setItem(deletedKey(botId), "1");
    window.dispatchEvent(new Event("aiden:open-work:pending-changed"));
    window.dispatchEvent(new Event("aiden:routine-model-pending"));
    window.dispatchEvent(new Event("aiden:bot-resume-pending"));
    return localStorage.getItem(deletedKey(botId)) === "1";
  } catch { return false; }
}

export function pendingChangeBotIds(): string[] {
  if (typeof localStorage === "undefined") return [];
  const result = new Set<string>();
  for (let index = 0; index < localStorage.length; index++) {
    const name = localStorage.key(index); if (!name) continue;
    const watch = "aiden:pending-connector-watch:";
    let candidate: string | undefined;
    if (name.startsWith(watch)) candidate = name.slice(watch.length);
    else for (const prefix of ["aiden:open-work:pending:", "aiden:routine-model:pending:", "aiden:bot-resume:pending:"]) if (name.startsWith(prefix)) {
      try { candidate = decodeURIComponent(name.slice(prefix.length).split(":")[0]!); } catch { /* Preserve an unidentifiable saved record. */ }
    }
    if (candidate && /^[A-Za-z0-9._:-]{1,160}$/u.test(candidate)) result.add(candidate);
  }
  return [...result];
}
