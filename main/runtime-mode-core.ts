export function isDevelopmentRuntime(environment: NodeJS.ProcessEnv): boolean {
  return typeof environment.AIDEN_RENDERER_URL === "string" && environment.AIDEN_RENDERER_URL.length > 0;
}
