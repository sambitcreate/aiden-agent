import { configStore } from "../config-store.js";
import { llmClient } from "../llm-client.js";

export async function formFillSpecialistEnabled(): Promise<boolean> {
  return (await configStore.getSettings()).formFillSpecialistEnabled === true;
}

/**
 * Persist the specialist toggle. Turning it off cancels any in-flight
 * generations so pending review plans and batch authority are revoked through
 * the normal generation-cancellation path.
 */
export async function setFormFillSpecialistEnabled(
  enabled: boolean,
): Promise<void> {
  await configStore.setSettings({ formFillSpecialistEnabled: enabled });
  if (!enabled) llmClient.cancelComputerUseGenerations();
}
