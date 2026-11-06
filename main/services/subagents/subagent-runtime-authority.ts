// Parent-only authority for the source runtime of an isolated helper request.
// Runtime copies, tool arguments and worker messages cannot manufacture it.
import type { ResolvedModelRuntime } from "../model-runtime-core.js";

export interface SubagentProviderAuthority {
  signal?: AbortSignal;
  revalidate(): Promise<void>;
}
export interface SubagentRuntimeTransformContext { childId: string; runId: string }
export type SubagentRuntimeTransform = (runtime: ResolvedModelRuntime, context: SubagentRuntimeTransformContext) => ResolvedModelRuntime;
const authorities = new WeakMap<ResolvedModelRuntime, SubagentProviderAuthority>();

export function registerSubagentProviderAuthority(runtime: ResolvedModelRuntime, authority: SubagentProviderAuthority): void {
  if (authorities.has(runtime)) throw new Error("This helper runtime already has an originating authority.");
  authorities.set(runtime, Object.freeze({ signal: authority.signal, revalidate: authority.revalidate.bind(authority) }));
}

export function subagentProviderAuthority(runtime: ResolvedModelRuntime): SubagentProviderAuthority | undefined {
  return authorities.get(runtime);
}
