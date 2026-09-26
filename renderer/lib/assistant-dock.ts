// The scheduled-task surface uses this narrow event to request a regular chat
// draft without owning workspace or navigation state itself.
const ASSISTANT_AUTOMATION_COMPOSE_EVENT = "aiden:assistant-create-automation";

export const ASSISTANT_AUTOMATION_DRAFT = "Create an automation that ";

export function requestAssistantAutomationComposer(): void {
  window.dispatchEvent(new Event(ASSISTANT_AUTOMATION_COMPOSE_EVENT));
}

export function onAssistantAutomationComposerRequested(handler: () => void): () => void {
  window.addEventListener(ASSISTANT_AUTOMATION_COMPOSE_EVENT, handler);
  return () => window.removeEventListener(ASSISTANT_AUTOMATION_COMPOSE_EVENT, handler);
}
