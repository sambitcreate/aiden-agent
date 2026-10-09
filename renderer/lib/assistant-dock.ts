// The scheduled-task surface uses this narrow event to request a regular chat
// draft without owning workspace or navigation state itself.
const ASSISTANT_AUTOMATION_COMPOSE_EVENT = "aiden:assistant-create-automation";

export const ASSISTANT_AUTOMATION_DRAFT = "Create an automation that ";

export function requestAssistantAutomationComposer(draft = ASSISTANT_AUTOMATION_DRAFT): void {
  window.dispatchEvent(new CustomEvent(ASSISTANT_AUTOMATION_COMPOSE_EVENT, { detail: draft }));
}

export function onAssistantAutomationComposerRequested(handler: (draft: string) => void): () => void {
  const listener = (event: Event) => handler(
    event instanceof CustomEvent && typeof event.detail === "string"
      ? event.detail : ASSISTANT_AUTOMATION_DRAFT,
  );
  window.addEventListener(ASSISTANT_AUTOMATION_COMPOSE_EVENT, listener);
  return () => window.removeEventListener(ASSISTANT_AUTOMATION_COMPOSE_EVENT, listener);
}
