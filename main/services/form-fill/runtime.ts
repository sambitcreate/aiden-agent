import { promises as fsp } from "node:fs";
import * as path from "node:path";
import {
  FormFillArtifactStore,
  formFillPackagePath,
  isFormFillSupported,
  verifyFormFillPackage,
} from "./artifacts-core.js";
import {
  FormFillHelperClient,
  FormFillHelperError,
  type FormFillScoreResult,
} from "./helper-client.js";
import { FORM_FILL_MODEL_REVISION } from "./manifest.js";

export type {
  FormFillArtifactStatus,
  FormFillArtifactState,
} from "./artifacts.js";

/**
 * Coordinator for the on-device form-fill runtime: artifact lifecycle plus a
 * warm helper process. Compiled model output is cached beside the package so
 * `load` is cheap on subsequent uses.
 */
export class FormFillRuntime {
  private client: FormFillHelperClient | null = null;
  private compiled: string | null = null;
  private preparation: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private lifecycle = new AbortController();

  constructor(
    readonly artifacts: FormFillArtifactStore,
    private readonly deps: {
      clientFactory: () => FormFillHelperClient;
      supported?: typeof isFormFillSupported;
      verifyPackage?: typeof verifyFormFillPackage;
    },
  ) {}

  private getClient(): FormFillHelperClient {
    if (!this.client || this.client.isPoisoned) {
      this.client?.dispose();
      this.preparation = null;
      this.client = this.deps.clientFactory();
    }
    return this.client;
  }

  /** Ensure the downloaded package verifies, then warm the helper with the
   * cached compiled bundle (compiling once when missing). */
  async ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.stopping)
      throw new FormFillHelperError(
        "cancelled",
        "The form-fill runtime is stopping.",
      );
    const bound = signal
      ? AbortSignal.any([signal, this.lifecycle.signal])
      : this.lifecycle.signal;
    bound.throwIfAborted();
    const support = (this.deps.supported ?? isFormFillSupported)();
    if (!support.supported) {
      throw new FormFillHelperError(
        "unavailable",
        support.reason ?? "Form fill is unsupported.",
      );
    }
    const failure = await (this.deps.verifyPackage ?? verifyFormFillPackage)(
      this.artifacts.rootDir,
    );
    bound.throwIfAborted();
    if (failure)
      throw new FormFillHelperError(
        "artifact_unavailable",
        `The form-fill model is not usable: ${failure}`,
      );
    const client = this.getClient();
    if (!this.preparation) {
      const preparation = this.prepare(client, this.lifecycle.signal);
      this.preparation = preparation;
      void preparation.catch(() => {
        if (this.preparation === preparation) this.preparation = null;
      });
    }
    const preparation = this.preparation;
    let cancel: () => void = () => {};
    try {
      await Promise.race([
        preparation,
        new Promise<never>((_resolve, reject) => {
          cancel = () => reject(bound.reason ?? new Error("Form fill cancelled."));
          bound.addEventListener("abort", cancel, { once: true });
          if (bound.aborted) cancel();
        }),
      ]);
    } finally {
      bound.removeEventListener("abort", cancel);
    }
    bound.throwIfAborted();
  }

  private async prepare(
    client: FormFillHelperClient,
    signal: AbortSignal,
  ): Promise<void> {
    const compiled = await this.compiledModelPath(signal);
    signal.throwIfAborted();
    try {
      await client.loadModel(compiled, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (
        error instanceof FormFillHelperError &&
        (error.code === "transport" || error.code === "timeout")
      ) {
        client.dispose();
        this.client = this.deps.clientFactory();
        await this.client.loadModel(compiled, signal);
        return;
      }
      throw error;
    }
  }

  /**
   * Compile-once cache: `…/form-fill-model.compiled/<revision>/<package>.mlmodelc`.
   * Generated files never enter the manifest-verified source tree.
   */
  private async compiledModelPath(signal?: AbortSignal): Promise<string> {
    const root = this.artifacts.rootDir;
    const packagePath = formFillPackagePath(root);
    const compiledDir = path.join(
      this.artifacts.compiledDir,
      FORM_FILL_MODEL_REVISION,
    );
    if (this.compiled) return this.compiled;
    // Never trust compiled bytes left by an earlier process. Compile from the
    // verified source once per runtime, then reuse this process-owned result.
    await fsp.rm(this.artifacts.compiledDir, { recursive: true, force: true });
    signal?.throwIfAborted();
    const compiled = await this.getClient().compileModel(
      packagePath,
      compiledDir,
      signal,
    );
    signal?.throwIfAborted();
    this.compiled = compiled;
    return this.compiled;
  }

  async score(
    context: string,
    options: string[],
    signal?: AbortSignal,
  ): Promise<FormFillScoreResult> {
    const bound = signal
      ? AbortSignal.any([signal, this.lifecycle.signal])
      : this.lifecycle.signal;
    await this.ensureReady(bound);
    bound.throwIfAborted();
    const client = this.getClient();
    try {
      return await client.score(context, options, bound);
    } catch (error) {
      if (
        error instanceof FormFillHelperError &&
        error.code === "model_not_loaded"
      ) {
        // Helper restarted or lost state — reload once, then fail closed.
        this.preparation = null;
        await this.ensureReady(bound);
        return this.getClient().score(context, options, bound);
      }
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.lifecycle.abort();
    const pending = this.preparation;
    this.stopping = (async () => {
      await pending?.catch(() => {});
      await this.client?.shutdown();
    })().finally(() => {
      this.client = null;
      this.compiled = null;
      this.preparation = null;
      this.lifecycle = new AbortController();
      this.stopping = null;
    });
    return this.stopping;
  }
}
