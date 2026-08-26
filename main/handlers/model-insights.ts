import { ipcMain, logger } from "../platform.js";
import { runModelInsightsAction } from "../services/model-insights-action-core.js";
import { openRouterBenchmarkRuntime } from "../services/openrouter-benchmark-runtime.js";

function unexpected(message: string) {
  return (error: unknown) =>
    logger.warn("model-insights", message, {
      errorType: error instanceof Error ? error.name : typeof error,
    });
}

export function registerModelInsightsHandlers(): void {
  ipcMain.handle("modelInsights:status", async () => openRouterBenchmarkRuntime.status());
  ipcMain.handle("modelInsights:connect", async (_event, apiKey: unknown) =>
    runModelInsightsAction(
      () => openRouterBenchmarkRuntime.connect(apiKey),
      "Aiden could not save the Model Pad OpenRouter connection.",
      unexpected("Could not connect Model Pad to OpenRouter benchmark data."),
    ),
  );
  ipcMain.handle("modelInsights:refresh", async () =>
    runModelInsightsAction(
      () => openRouterBenchmarkRuntime.refresh(),
      "Aiden could not save the refreshed model insights.",
      unexpected("Could not refresh model insights."),
    ),
  );
  ipcMain.handle("modelInsights:clear", async () =>
    runModelInsightsAction(
      () => openRouterBenchmarkRuntime.clear(),
      "Aiden could not clear the device-local model insights.",
      unexpected("Could not clear model insights."),
    ),
  );
  ipcMain.handle("modelInsights:disconnect", async () =>
    runModelInsightsAction(
      () => openRouterBenchmarkRuntime.disconnect(),
      "Aiden could not remove the Model Pad OpenRouter connection.",
      unexpected("Could not disconnect Model Pad from OpenRouter benchmark data."),
    ),
  );
}
