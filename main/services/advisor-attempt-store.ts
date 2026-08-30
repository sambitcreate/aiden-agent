import { DataStore } from "./data-store.js";

export const MAX_ADVISOR_ATTEMPTS = 512;

export type AdvisorAttemptState =
  | "prepared"
  | "dispatch_started"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type AdvisorAttemptFailure =
  | "none"
  | "auth"
  | "model_unavailable"
  | "context"
  | "provider"
  | "timeout"
  | "cancelled"
  | "host";

export interface AdvisorAttemptV1 {
  version: 1;
  attemptId: string;
  providerId: string;
  modelId: string;
  state: AdvisorAttemptState;
  failure: AdvisorAttemptFailure;
  preparedAt: number;
  updatedAt: number;
  usageRecorded: boolean;
}

export interface AdvisorAttemptDatabaseV1 {
  version: 1;
  revision: number;
  attempts: AdvisorAttemptV1[];
}

const SAFE_ID = /^[^\p{Cc}]{1,256}$/u;
const STATES = new Set<AdvisorAttemptState>([
  "prepared",
  "dispatch_started",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
const FAILURES = new Set<AdvisorAttemptFailure>([
  "none",
  "auth",
  "model_unavailable",
  "context",
  "provider",
  "timeout",
  "cancelled",
  "host",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function parseAdvisorAttempt(value: unknown): AdvisorAttemptV1 | null {
  const input = record(value);
  if (
    !input ||
    !exactKeys(input, [
      "version",
      "attemptId",
      "providerId",
      "modelId",
      "state",
      "failure",
      "preparedAt",
      "updatedAt",
      "usageRecorded",
    ]) ||
    input.version !== 1 ||
    typeof input.attemptId !== "string" ||
    !SAFE_ID.test(input.attemptId) ||
    typeof input.providerId !== "string" ||
    !SAFE_ID.test(input.providerId) ||
    typeof input.modelId !== "string" ||
    !SAFE_ID.test(input.modelId) ||
    !STATES.has(input.state as AdvisorAttemptState) ||
    !FAILURES.has(input.failure as AdvisorAttemptFailure) ||
    typeof input.preparedAt !== "number" ||
    !Number.isFinite(input.preparedAt) ||
    input.preparedAt < 0 ||
    typeof input.updatedAt !== "number" ||
    !Number.isFinite(input.updatedAt) ||
    input.updatedAt < input.preparedAt ||
    typeof input.usageRecorded !== "boolean"
  ) {
    return null;
  }
  return structuredClone(input) as unknown as AdvisorAttemptV1;
}

export function parseAdvisorAttemptDatabase(value: unknown): AdvisorAttemptDatabaseV1 | null {
  const input = record(value);
  if (
    !input ||
    !exactKeys(input, ["version", "revision", "attempts"]) ||
    input.version !== 1 ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) < 0 ||
    !Array.isArray(input.attempts) ||
    input.attempts.length > MAX_ADVISOR_ATTEMPTS
  ) {
    return null;
  }
  const attempts = input.attempts.map(parseAdvisorAttempt);
  if (
    attempts.some((attempt) => attempt === null) ||
    new Set(attempts.map((attempt) => attempt!.attemptId)).size !== attempts.length
  ) {
    return null;
  }
  return {
    version: 1,
    revision: input.revision as number,
    attempts: attempts as AdvisorAttemptV1[],
  };
}

function emptyDatabase(): AdvisorAttemptDatabaseV1 {
  return { version: 1, revision: 0, attempts: [] };
}

function terminal(state: AdvisorAttemptState): boolean {
  return state !== "prepared" && state !== "dispatch_started";
}

export interface AdvisorAttemptStoreOptions {
  root?: () => string;
  filename?: string;
  now?: () => number;
  dataStore?: DataStore<AdvisorAttemptDatabaseV1>;
}

export class AdvisorAttemptStore {
  private readonly data: DataStore<AdvisorAttemptDatabaseV1>;
  private readonly now: () => number;
  private initialized = false;

  constructor(options: AdvisorAttemptStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.data =
      options.dataStore ??
      new DataStore<AdvisorAttemptDatabaseV1>(
        options.filename ?? "advisor-attempts.json",
        emptyDatabase(),
        options.root,
        {
          maxBytes: 512 * 1024,
          fileMode: 0o600,
          normalize: (value) => parseAdvisorAttemptDatabase(value) ?? emptyDatabase(),
          isSafe: (value) => parseAdvisorAttemptDatabase(value) !== null,
          rejectCorruptWrite: true,
          rejectUnsafeWrite: true,
        },
      );
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid advisor attempt clock.");
    return value;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("Advisor attempt storage is not initialized.");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.data.load();
    if (await this.data.loadedFromCorruptFile()) {
      throw new Error("Advisor attempt storage is unreadable and was preserved.");
    }
    if (await this.data.loadedFromUnsafeFile()) {
      throw new Error("Advisor attempt storage has an unsupported shape and was preserved.");
    }
    const restartedAt = this.timestamp();
    await this.data.update((database) => {
      let changed = false;
      database.attempts = database.attempts.map((attempt) => {
        if (terminal(attempt.state)) return attempt;
        changed = true;
        return {
          ...attempt,
          state: attempt.state === "prepared" ? ("cancelled" as const) : ("unknown" as const),
          failure: attempt.state === "prepared" ? ("cancelled" as const) : ("host" as const),
          updatedAt: Math.max(attempt.updatedAt, restartedAt),
        };
      });
      if (changed) database.revision += 1;
    });
    this.initialized = true;
  }

  async prepare(attemptId: string, providerId: string, modelId: string): Promise<AdvisorAttemptV1> {
    this.requireInitialized();
    if (![attemptId, providerId, modelId].every((value) => SAFE_ID.test(value))) {
      throw new Error("Invalid advisor attempt identity.");
    }
    const preparedAt = this.timestamp();
    return this.data.update((database) => {
      if (database.attempts.some((attempt) => attempt.attemptId === attemptId)) {
        throw new Error("Advisor attempt identity was reused.");
      }
      while (database.attempts.length >= MAX_ADVISOR_ATTEMPTS) {
        const index = database.attempts.findIndex((attempt) => terminal(attempt.state));
        if (index < 0) throw new Error("Advisor attempt history is at capacity.");
        database.attempts.splice(index, 1);
      }
      const attempt: AdvisorAttemptV1 = {
        version: 1,
        attemptId,
        providerId,
        modelId,
        state: "prepared",
        failure: "none",
        preparedAt,
        updatedAt: preparedAt,
        usageRecorded: false,
      };
      database.attempts.push(attempt);
      database.revision += 1;
      return structuredClone(attempt);
    });
  }

  private async update(
    attemptId: string,
    mutate: (attempt: AdvisorAttemptV1, timestamp: number) => void,
  ): Promise<AdvisorAttemptV1> {
    this.requireInitialized();
    const updatedAt = this.timestamp();
    return this.data.update((database) => {
      const attempt = database.attempts.find((entry) => entry.attemptId === attemptId);
      if (!attempt) throw new Error("Advisor attempt was not found.");
      mutate(attempt, updatedAt);
      database.revision += 1;
      return structuredClone(attempt);
    });
  }

  markDispatchStarted(attemptId: string): Promise<AdvisorAttemptV1> {
    return this.update(attemptId, (attempt, updatedAt) => {
      if (attempt.state !== "prepared") throw new Error("Advisor attempt was already dispatched.");
      attempt.state = "dispatch_started";
      attempt.updatedAt = Math.max(attempt.updatedAt, updatedAt);
    });
  }

  settle(
    attemptId: string,
    state: Extract<AdvisorAttemptState, "completed" | "failed" | "cancelled">,
    failure: AdvisorAttemptFailure,
  ): Promise<AdvisorAttemptV1> {
    return this.update(attemptId, (attempt, updatedAt) => {
      if (attempt.state !== "dispatch_started") {
        throw new Error("Advisor attempt dispatch evidence is unavailable.");
      }
      attempt.state = state;
      attempt.failure = failure;
      attempt.updatedAt = Math.max(attempt.updatedAt, updatedAt);
    });
  }

  markUsageRecorded(attemptId: string): Promise<AdvisorAttemptV1> {
    return this.update(attemptId, (attempt, updatedAt) => {
      if (!terminal(attempt.state)) throw new Error("Advisor attempt is not settled.");
      attempt.usageRecorded = true;
      attempt.updatedAt = Math.max(attempt.updatedAt, updatedAt);
    });
  }

  async list(): Promise<AdvisorAttemptV1[]> {
    this.requireInitialized();
    return structuredClone((await this.data.load()).attempts);
  }
}
