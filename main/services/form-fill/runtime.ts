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
import { defaultFormFillHelperPaths } from "./helper-paths.js";
import { FORM_FILL_MODEL_PACKAGE_DIR } from "./manifest.js";

export type { FormFillArtifactStatus, FormFillArtifactState } from "./artifacts.js";

/**
 * Coordinator for the on-device form-fill runtime: artifact lifecycle plus a
 * warm helper process. Compiled model output is cached beside the package so
 * `load` is cheap on subsequent uses.
 */
export class FormFillRuntime {
  private client: FormFillHelperClient | null = null;

  constructor(
    readonly artifacts: FormFillArtifactStore,
    private readonly deps: {
      clientFactory?: () => FormFillHelperClient;
    } = {},
  ) {}

  private getClient(): FormFillHelperClient {
    if (!this.client || this.client.isPoisoned) {
      this.client?.dispose();
      this.client = (
        this.deps.clientFactory ??
        (() =>
          new FormFillHelperClient({ pathsResolver: defaultFormFillHelperPaths }))
      )();
    }
    return this.client;
  }

  /** Ensure the downloaded package verifies, then warm the helper with the
   * cached compiled bundle (compiling once when missing). */
  async ensureReady(signal?: AbortSignal): Promise<void> {
    const support = isFormFillSupported();
    if (!support.supported) {
      throw new FormFillHelperError("unavailable", support.reason ?? "Form fill is unsupported.");
    }
    const failure = await verifyFormFillPackage(this.artifacts.rootDir);
    if (failure) {
      throw new FormFillHelperError("artifact_unavailable", `The form-fill model is not usable: ${failure}`);
    }
    const client = this.getClient();
    const compiled = await this.compiledModelPath(signal);
    try {
      await client.loadModel(compiled, signal);
    } catch (error) {
      // One restart for a poisoned/crashed helper before surfacing failure.
      if (
        error instanceof FormFillHelperError &&
        (error.code === "transport" || error.code === "timeout")
      ) {
        client.dispose();
        this.client = null;
        await this.getClient().loadModel(compiled, signal);
        return;
      }
      throw error;
    }
  }

  /**
   * Compile-once cache: `…/form-fill-model/compiled/<package>.mlmodelc`.
   * Only runs inside the model directory, never touches anything else.
   */
  private async compiledModelPath(signal?: AbortSignal): Promise<string> {
    const root = this.artifacts.rootDir;
    const packagePath = formFillPackagePath(root);
    const compiledDir = path.join(root, "compiled");
    const compiled = path.join(compiledDir, `${FORM_FILL_MODEL_PACKAGE_DIR}.mlmodelc`);
    try {
      const stat = await fsp.stat(compiled);
      if (stat.isDirectory()) return compiled;
    } catch {
      // fall through to compile
    }
    return this.getClient().compileModel(packagePath, compiledDir, signal);
  }

  async score(context: string, options: string[], signal?: AbortSignal): Promise<FormFillScoreResult> {
    await this.ensureReady(signal);
    const client = this.getClient();
    try {
      return await client.score(context, options, signal);
    } catch (error) {
      if (error instanceof FormFillHelperError && error.code === "model_not_loaded") {
        // Helper restarted or lost state — reload once, then fail closed.
        await this.ensureReady(signal);
        return this.getClient().score(context, options, signal);
      }
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    await this.client?.shutdown();
    this.client = null;
  }
}


