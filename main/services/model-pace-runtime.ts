import { logger } from "../platform.js";
import { createModelPacePersistence, ModelPaceRecorder } from "./model-pace-core.js";

/** The app-wide device-local pace recorder (`userData/model-pace.json`). */
export const modelPaceRecorder = new ModelPaceRecorder(createModelPacePersistence(), {
  onError: (error) =>
    logger.debug("model-pace", "Model pace measurement was not stored.", {
      errorType: error instanceof Error ? error.name : typeof error,
    }),
});
