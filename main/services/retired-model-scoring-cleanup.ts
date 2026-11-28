import { app, logger } from "../platform.js";
import { piCredentialStore } from "./pi-credential-store.js";
import {
  removeRetiredModelScoringData,
  RETIRED_DESKTOP_MODEL_SCORING,
} from "./retired-model-scoring-cleanup-core.js";

/**
 * Delete the retired benchmark, Artificial Analysis and measured-pace data.
 * Runs at startup (not awaited) and on onboarding reset. Never rejects; a
 * failure is logged and the next run tries again.
 */
export async function cleanUpRetiredModelScoring(): Promise<void> {
  try {
    await removeRetiredModelScoringData({
      directory: app.getPath("userData"),
      ...RETIRED_DESKTOP_MODEL_SCORING,
      credentials: {
        has: async (id) =>
          (await piCredentialStore.list()).some((entry) => entry.providerId === id),
        delete: (id) => piCredentialStore.delete(id),
      },
      onFailure: (item, error) =>
        logger.debug(
          "retired-model-scoring",
          `Could not remove ${item}; it will be retried next launch.`,
          {
            errorType: error instanceof Error ? error.name : typeof error,
          },
        ),
    });
  } catch (error) {
    logger.debug("retired-model-scoring", "Could not clean up retired model scoring data.", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
}
