/**
 * Node prints "ExperimentalWarning: SQLite is an experimental feature" the
 * first time anything loads `node:sqlite`, which the session and run stores
 * do. Bundled ESM links that import before any module body runs, so the
 * filter has to be installed by an entry that loads the runtime afterwards
 * with a dynamic import. Every other warning still reaches the default
 * handler.
 */
export function isSqliteExperimentalWarning(warning: string | Error, typeOrOptions?: unknown): boolean {
	const type =
		typeof typeOrOptions === "string"
			? typeOrOptions
			: typeof typeOrOptions === "object" && typeOrOptions !== null && "type" in typeOrOptions
				? (typeOrOptions as { type?: unknown }).type
				: undefined;
	const isExperimental = type === "ExperimentalWarning" || (warning instanceof Error && warning.name === "ExperimentalWarning");
	const message = warning instanceof Error ? warning.message : warning;
	return isExperimental && typeof message === "string" && /\bSQLite\b/.test(message);
}

export function suppressSqliteExperimentalWarning(): void {
	const emitWarning = process.emitWarning;
	process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
		if (isSqliteExperimentalWarning(warning, rest[0])) return;
		return (emitWarning as (...args: unknown[]) => void).call(this, warning, ...rest);
	} as typeof process.emitWarning;
}
