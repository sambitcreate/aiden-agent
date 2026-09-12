/** Call only while the project lifecycle lane excludes active appends. */
export async function reconcileDesignGenerationAppend(input: {
  projectId: string;
  readChat: () => Promise<{ messages: readonly { id: string; role: string }[] } | null>;
  reconcile: (input: { projectId: string; persistedUserMessageIds: string[] }) => Promise<unknown>;
}): Promise<boolean> {
  // A read failure is an uncertain commit, never evidence of an absent turn.
  // Missing chats are left for lifecycle deletion recovery.
  const chat = await input.readChat();
  if (!chat) return false;
  await input.reconcile({
    projectId: input.projectId,
    persistedUserMessageIds: chat.messages.filter((message) => message.role === "user").map((message) => message.id),
  });
  return true;
}
