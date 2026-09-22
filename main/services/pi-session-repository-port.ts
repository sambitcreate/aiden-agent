import {
  assertJsonSerializable,
  InMemorySessionRepo,
  JsonlSessionRepo,
  type JsonlSessionMetadata,
  type JsonValue,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createPiSessionPort,
  type PiPersistentSessionMetadata,
  type PiSessionPort,
} from "./pi-session-port.js";

export interface PiSessionRepositoryPort {
  list(): Promise<PiPersistentSessionMetadata[]>;
  open(metadata: PiPersistentSessionMetadata): Promise<PiSessionPort<PiPersistentSessionMetadata>>;
  create(options: {
    id: string;
    cwd: string;
    metadata: Record<string, unknown>;
  }): Promise<PiSessionPort<PiPersistentSessionMetadata>>;
  delete(metadata: PiPersistentSessionMetadata): Promise<void>;
}

class CurrentPiSessionRepositoryPort implements PiSessionRepositoryPort {
  readonly #repository: JsonlSessionRepo;

  constructor(root: string) {
    this.#repository = new JsonlSessionRepo({
      fs: new NodeExecutionEnv({ cwd: root }),
      sessionsRoot: root,
    });
  }

  async list(): Promise<PiPersistentSessionMetadata[]> {
    return (await this.#repository.list()).map((metadata) => ({
      id: metadata.id,
      createdAt: metadata.createdAt,
      cwd: metadata.cwd,
      path: metadata.path,
      modifiedAt: metadata.modifiedAt,
      sourceFormat: 4,
      ...(metadata.parentSessionId === undefined
        ? {}
        : { parentSessionId: metadata.parentSessionId }),
      ...(metadata.legacyParentSessionPath === undefined
        ? {}
        : { legacyParentSessionPath: metadata.legacyParentSessionPath }),
      ...(metadata.metadata === undefined ? {} : { metadata: metadata.metadata }),
    }));
  }

  async open(
    metadata: PiPersistentSessionMetadata,
  ): Promise<PiSessionPort<PiPersistentSessionMetadata>> {
    return createPiSessionPort(await this.#repository.open(metadata as JsonlSessionMetadata));
  }

  async create(options: {
    id: string;
    cwd: string;
    metadata: Record<string, unknown>;
  }): Promise<PiSessionPort<PiPersistentSessionMetadata>> {
    assertJsonSerializable(options.metadata);
    return createPiSessionPort(
      await this.#repository.create({
        ...options,
        metadata: options.metadata as Record<string, JsonValue>,
      }),
    );
  }

  async delete(metadata: PiPersistentSessionMetadata): Promise<void> {
    await this.#repository.delete(metadata as JsonlSessionMetadata);
  }
}

export function createCurrentPiSessionRepository(root: string): PiSessionRepositoryPort {
  return new CurrentPiSessionRepositoryPort(root);
}

/** Isolated child-session factory; Pi repository churn stops at this module. */
export async function createInMemoryPiSession(id: string): Promise<PiSessionPort> {
  return createPiSessionPort(await new InMemorySessionRepo().create({ id }));
}
