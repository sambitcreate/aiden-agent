declare module "pi-cursor-sdk/dist/model-discovery.js" {
  export function discoverModels(options?: {
    apiKey?: string;
    forceRefresh?: boolean;
    onFallback?: (issue: { message: string; reason?: string }) => void;
  }): Promise<
    Array<{
      id: string;
      name: string;
      reasoning?: boolean;
      thinkingLevelMap?: import("@earendil-works/pi-ai").ThinkingLevelMap;
      input?: Array<"text" | "image">;
      cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
    }>
  >;
}

declare module "pi-cursor-sdk/dist/cursor-provider-lazy.js" {
  import type {
    Api,
    AssistantMessageEventStream,
    Context,
    Model,
    SimpleStreamOptions,
  } from "@earendil-works/pi-ai";

  export function streamCursorLazy(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
}

declare module "pi-cursor-sdk/dist/cursor-session-scope.js" {
  export const __testUtils: {
    set(
      cwd: string,
      sessionFile: string | undefined,
      sessionId?: string,
      projectTrusted?: boolean,
      sessionName?: string,
    ): void;
  };
}
