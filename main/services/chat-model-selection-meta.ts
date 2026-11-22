// Which model a generation's chat writes record as the chat's own. A turn
// normally answers on the chat's model, so its saved messages keep the chat on
// that model. An in-chat scheduled task run answers on the task's model: its
// writes leave the chat's stored model untouched, so the person's next
// message goes out on the model they chose.

/** The `providerId`/`model` append fields for a generation's chat writes. */
export function generationModelMeta(
  run: { providerId: string; model: string },
  keepChatModel: boolean | undefined,
): { providerId?: string; model?: string } {
  return keepChatModel ? {} : { providerId: run.providerId, model: run.model };
}
