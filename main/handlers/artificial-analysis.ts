import { ipcMain, logger } from "../platform.js";
import { artificialAnalysisRuntime } from "../services/artificial-analysis-runtime.js";
import { runArtificialAnalysisAction } from "../services/artificial-analysis-action-core.js";

async function action(
  operation: Parameters<typeof runArtificialAnalysisAction>[0],
  fallbackMessage: string,
): ReturnType<typeof runArtificialAnalysisAction> {
  return runArtificialAnalysisAction(operation, {
    fallbackMessage,
    onUnexpected: (error) => {
      logger.warn("artificial-analysis", fallbackMessage, {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    },
  });
}

export function registerArtificialAnalysisHandlers(): void {
  ipcMain.handle("artificialAnalysis:status", async () => artificialAnalysisRuntime.status());
  ipcMain.handle("artificialAnalysis:connect", async (_event, apiKey: unknown) =>
    action(
      () => artificialAnalysisRuntime.connect(apiKey),
      "Aiden could not save the Artificial Analysis connection.",
    ),
  );
  ipcMain.handle("artificialAnalysis:refresh", async () =>
    action(
      () => artificialAnalysisRuntime.refresh(),
      "Aiden could not save the refreshed Artificial Analysis data.",
    ),
  );
  ipcMain.handle("artificialAnalysis:disconnect", async () =>
    action(
      () => artificialAnalysisRuntime.disconnect(),
      "Aiden could not remove the Artificial Analysis connection.",
    ),
  );
}
