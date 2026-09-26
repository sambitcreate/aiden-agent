/**
 * Types for the prebundled advisor runtime (dist/app/advisor-runtime.vendor.mjs).
 * The vendor module is built by scripts/build.mjs from
 * src/vendor/advisor/advisor-runtime.ts; the CLI consumes it as an external
 * runtime import so the main bundle does not re-inline it.
 */
export declare class AdvisorRuntime {
	constructor(dependencies: Record<string, unknown>);
	extensionForGeneration(input: unknown): Promise<{
		id: string;
		systemPrompt?: string;
		tools?: ReadonlyArray<{ execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }>;
	} | null>;
}
