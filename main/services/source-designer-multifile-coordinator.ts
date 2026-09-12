import {
  SOURCE_DESIGNER_MULTIFILE_MAX_FILES,
  SOURCE_DESIGNER_MULTIFILE_MAX_FILE_BYTES,
  SOURCE_DESIGNER_MULTIFILE_MAX_IMAGE_BYTES,
  SOURCE_DESIGNER_MULTIFILE_VERSION,
  type SourceDesignerMultifileByteImageV1,
  type SourceDesignerMultifileConflictV1,
  type SourceDesignerMultifileEffectPhase,
  type SourceDesignerMultifileFileV1,
  type SourceDesignerMultifileRecordV1,
  type SourceDesignerMultifileRecoveryKind,
  type SourceDesignerMultifileStage,
  createSourceDesignerMultifileImage,
  decodeSourceDesignerMultifileImage,
  parseSourceDesignerMultifilePath,
  parseSourceDesignerMultifileRecord,
  sourceDesignerMultifileComparePaths,
  sourceDesignerMultifileEffectId,
  sourceDesignerMultifilePathCollisionKey,
  sourceDesignerMultifileSha256,
} from "./source-designer-multifile-contract.js";
import type { SourceDesignerMultifileJournalPort } from "./source-designer-multifile-journal.js";

export interface SourceDesignerMultifileObservation {
  /** Must equal the canonical portable path requested by the coordinator. */
  path: string;
  /** The production adapter must use no-follow traversal and reject all links. */
  noFollow: true;
  /** The opened regular file and every retained ancestor remain under the authorized root. */
  contained: true;
  kind: "regular-file";
  bytes: Uint8Array;
  byteSize: number;
  sha256: string;
  rootFingerprint?: string;
}

export interface SourceDesignerMultifileFilePort {
  inspect(input: {
    workspaceId: string;
    path: string;
    expectedRootFingerprint?: string;
  }): Promise<SourceDesignerMultifileObservation>;
  /**
   * Atomically replace one no-follow regular file if its current digest equals
   * expectedSha256. Calls are idempotent by effectId and must never follow a
   * link or cross the authorized workspace root.
   */
  write(input: {
    workspaceId: string;
    path: string;
    effectId: string;
    expectedSha256: string;
    bytes: Uint8Array;
    expectedRootFingerprint?: string;
  }): Promise<SourceDesignerMultifileObservation>;
}

export interface PrepareSourceDesignerMultifileInput {
  actionId: string;
  workspaceId: string;
  projectId?: string;
  chatId?: string;
  projectRevision?: number;
  sourceNodeId?: string;
  sourceSelectionId?: string;
  sourceManifestHash?: string;
  sourcePath?: string;
  sourceStart?: number;
  sourceEnd?: number;
  sourceLineNumber?: number;
  sourceColumnNumber?: number;
  sourceComponentName?: string;
  sourceSelector?: string;
  sourceTagName?: string;
  sourceElementId?: string;
  sourceAfterManifestHash?: string;
  sourceAfterVersion?: string;
  sourceAfterStart?: number;
  sourceAfterEnd?: number;
  sourceAfterLineNumber?: number;
  sourceAfterColumnNumber?: number;
  label: string;
  files: Array<{
    path: string;
    expectedBeforeSha256: string;
    afterBytes: Uint8Array;
  }>;
}

export type SourceDesignerMultifileRunResult =
  | { status: "committed"; record: SourceDesignerMultifileRecordV1 }
  | { status: "rolled-back"; record: SourceDesignerMultifileRecordV1 }
  | { status: "undone"; record: SourceDesignerMultifileRecordV1 }
  | { status: "recoverable"; record: SourceDesignerMultifileRecordV1 };

class SourceDesignerMultifileObservedConflict extends Error {
  readonly name = "SourceDesignerMultifileObservedConflict";

  constructor(
    readonly kind: SourceDesignerMultifileRecoveryKind,
    readonly conflict: SourceDesignerMultifileConflictV1,
    readonly record: SourceDesignerMultifileRecordV1,
  ) {
    super(conflict.reason);
  }
}

class SourceDesignerMultifilePortFailure extends Error {
  readonly name = "SourceDesignerMultifilePortFailure";

  constructor(
    readonly record: SourceDesignerMultifileRecordV1,
    readonly file: SourceDesignerMultifileFileV1,
  ) {
    super("The authorized file adapter became unavailable.");
  }
}

function validateObservation(
  observation: SourceDesignerMultifileObservation,
  expectedPath: string,
): SourceDesignerMultifileObservation {
  const bytes = Buffer.from(observation.bytes);
  if (
    observation.path !== expectedPath ||
    observation.noFollow !== true ||
    observation.contained !== true ||
    observation.kind !== "regular-file" ||
    bytes.byteLength > SOURCE_DESIGNER_MULTIFILE_MAX_FILE_BYTES ||
    observation.byteSize !== bytes.byteLength ||
    observation.sha256 !== sourceDesignerMultifileSha256(bytes)
  ) {
    throw new Error("The authorized file adapter returned an invalid containment proof.");
  }
  return { ...observation, bytes };
}

function collisionSafeFiles(input: PrepareSourceDesignerMultifileInput): Array<{
  path: string;
  expectedBeforeSha256: string;
  after: SourceDesignerMultifileByteImageV1;
}> {
  for (const [value, name] of [
    [input.actionId, "Designer Action ID"],
    [input.workspaceId, "Designer Action workspace ID"],
  ] as const) {
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > 128 ||
      value.normalize("NFKC") !== value ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    ) {
      throw new Error(`${name} is invalid.`);
    }
  }
  if (
    typeof input.label !== "string" ||
    input.label.length === 0 ||
    Buffer.byteLength(input.label, "utf8") > 160 ||
    [...input.label].some((character) => {
      const code = character.charCodeAt(0);
      return code < 9 || code === 11 || code === 12 || (code > 13 && code < 32) || code === 127;
    })
  ) {
    throw new Error("Designer Action label is invalid.");
  }
  if (input.files.length < 1 || input.files.length > SOURCE_DESIGNER_MULTIFILE_MAX_FILES) {
    throw new Error("Designer Action file count is outside the supported limit.");
  }
  const seen = new Set<string>();
  const files = input.files.map((file) => {
    const path = parseSourceDesignerMultifilePath(file.path);
    const collision = sourceDesignerMultifilePathCollisionKey(path);
    if (seen.has(collision)) {
      throw new Error("Designer Action paths collide by case or Unicode form.");
    }
    seen.add(collision);
    if (!/^[a-f0-9]{64}$/u.test(file.expectedBeforeSha256)) {
      throw new Error(`Designer Action preimage digest for ${path} is invalid.`);
    }
    return {
      path,
      expectedBeforeSha256: file.expectedBeforeSha256,
      after: createSourceDesignerMultifileImage(file.afterBytes),
    };
  });
  files.sort((left, right) => sourceDesignerMultifileComparePaths(left.path, right.path));
  const byteSize = files.reduce((total, file) => total + file.after.byteSize, 0);
  if (byteSize > SOURCE_DESIGNER_MULTIFILE_MAX_IMAGE_BYTES) {
    throw new Error("Designer Action postimages exceed the transaction byte limit.");
  }
  return files;
}

function conflict(
  kind: SourceDesignerMultifileRecoveryKind,
  record: SourceDesignerMultifileRecordV1,
  file: SourceDesignerMultifileFileV1,
  expectedSha256: string,
  observation: SourceDesignerMultifileObservation,
  reason: string,
): SourceDesignerMultifileObservedConflict {
  return new SourceDesignerMultifileObservedConflict(
    kind,
    {
      path: file.path,
      expectedSha256,
      observedSha256: observation.sha256,
      observedByteSize: observation.byteSize,
      reason,
    },
    record,
  );
}

function result(record: SourceDesignerMultifileRecordV1): SourceDesignerMultifileRunResult {
  if (record.stage === "committed") return { status: "committed", record };
  if (record.stage === "rolled-back") return { status: "rolled-back", record };
  if (record.stage === "undone") return { status: "undone", record };
  if (record.stage === "recoverable") return { status: "recoverable", record };
  throw new Error("The Designer Action did not reach a returnable state.");
}

export function createSourceDesignerMultifileCoordinator(options: {
  journal: SourceDesignerMultifileJournalPort;
  files: SourceDesignerMultifileFilePort;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const queues = new Map<string, Promise<void>>();

  const checkpoint = async (
    current: SourceDesignerMultifileRecordV1,
    patch: Partial<SourceDesignerMultifileRecordV1> & { stage: SourceDesignerMultifileStage },
  ): Promise<SourceDesignerMultifileRecordV1> => {
    const next = parseSourceDesignerMultifileRecord({
      ...current,
      ...patch,
      version: SOURCE_DESIGNER_MULTIFILE_VERSION,
      revision: current.revision + 1,
      updatedAt: Math.max(current.updatedAt, now()),
    });
    return options.journal.replace(current.actionId, current.revision, next);
  };

  const advanceEffect = async (
    current: SourceDesignerMultifileRecordV1,
    index: number,
    field: "apply" | "rollback" | "undo",
    phase: SourceDesignerMultifileEffectPhase,
  ): Promise<SourceDesignerMultifileRecordV1> => {
    const files = structuredClone(current.files);
    files[index]![field].phase = phase;
    return checkpoint(current, { stage: current.stage, files });
  };

  const inspect = async (
    record: SourceDesignerMultifileRecordV1,
    file: SourceDesignerMultifileFileV1,
  ): Promise<SourceDesignerMultifileObservation> => {
    try {
      return validateObservation(
        await options.files.inspect({
          workspaceId: record.workspaceId,
          path: file.path,
          ...(record.rootFingerprint ? { expectedRootFingerprint: record.rootFingerprint } : {}),
        }),
        file.path,
      );
    } catch {
      throw new SourceDesignerMultifilePortFailure(record, file);
    }
  };

  const preserve = async (
    current: SourceDesignerMultifileRecordV1,
    kind: SourceDesignerMultifileRecoveryKind,
    conflicts: SourceDesignerMultifileConflictV1[],
  ): Promise<SourceDesignerMultifileRecordV1> => {
    const unique = new Map<string, SourceDesignerMultifileConflictV1>();
    for (const entry of conflicts) {
      if (!unique.has(entry.path)) unique.set(entry.path, entry);
    }
    return checkpoint(current, {
      stage: "recoverable",
      recovery: {
        kind,
        conflicts: [...unique.values()].sort((left, right) =>
          sourceDesignerMultifileComparePaths(left.path, right.path),
        ),
      },
    });
  };

  const revoke = async (
    actionId: string,
    reason: string,
  ): Promise<SourceDesignerMultifileRecordV1> => {
    const current = await options.journal.get(actionId);
    if (!current) throw new Error("Designer Action was not found.");
    if (["rolled-back", "undone", "recoverable"].includes(current.stage)) return current;
    if (["applying", "verifying", "rolling-back"].includes(current.stage)) {
      return (await rollback(current)).record;
    }
    if (current.stage === "undoing") return (await undo(actionId)).record;
    const file = current.files[0]!;
    return preserve(current, "authority-revoked", [
      {
        path: file.path,
        expectedSha256: current.stage === "committed" ? file.after.sha256 : file.before.sha256,
        reason,
      },
    ]);
  };

  const preservePortFailure = async (
    failure: SourceDesignerMultifilePortFailure,
  ): Promise<SourceDesignerMultifileRunResult> => {
    const existing = failure.record.recovery;
    const record = await preserve(failure.record, existing?.kind ?? "inspection-unavailable", [
      ...(existing?.conflicts ?? []),
      {
        path: failure.file.path,
        expectedSha256:
          failure.record.stage === "applying" || failure.record.stage === "verifying"
            ? failure.file.after.sha256
            : failure.file.before.sha256,
        reason: "Aiden could not inspect this file through the authorized adapter.",
      },
    ]);
    return result(record);
  };

  const driveApplyFile = async (
    initial: SourceDesignerMultifileRecordV1,
    index: number,
  ): Promise<SourceDesignerMultifileRecordV1> => {
    let current = initial;
    for (;;) {
      const file = current.files[index]!;
      const observed = await inspect(current, file);
      if (file.apply.phase === "pending") {
        if (observed.sha256 !== file.before.sha256) {
          throw conflict(
            "stale-preimage",
            current,
            file,
            file.before.sha256,
            observed,
            "The source changed before this Designer Action began.",
          );
        }
        current = await advanceEffect(current, index, "apply", "write-intent");
        continue;
      }
      if (file.apply.phase === "write-intent") {
        if (observed.sha256 === file.after.sha256) {
          current = await advanceEffect(current, index, "apply", "verifying");
          continue;
        }
        if (observed.sha256 !== file.before.sha256) {
          throw conflict(
            "apply-conflict",
            current,
            file,
            file.before.sha256,
            observed,
            "The source changed while this Designer Action was applying.",
          );
        }
        let written: SourceDesignerMultifileObservation;
        try {
          written = validateObservation(
            await options.files.write({
              workspaceId: current.workspaceId,
              path: file.path,
              effectId: file.apply.effectId,
              expectedSha256: file.before.sha256,
              bytes: decodeSourceDesignerMultifileImage(file.after),
              ...(current.rootFingerprint
                ? { expectedRootFingerprint: current.rootFingerprint }
                : {}),
            }),
            file.path,
          );
        } catch {
          let reconciled: SourceDesignerMultifileObservation;
          try {
            reconciled = validateObservation(
              await options.files.inspect({
                workspaceId: current.workspaceId,
                path: file.path,
                ...(current.rootFingerprint
                  ? { expectedRootFingerprint: current.rootFingerprint }
                  : {}),
              }),
              file.path,
            );
          } catch {
            throw new SourceDesignerMultifilePortFailure(current, file);
          }
          if (reconciled.sha256 === file.after.sha256) {
            written = reconciled;
          } else if (reconciled.sha256 === file.before.sha256) {
            throw conflict(
              "inspection-unavailable",
              current,
              file,
              file.after.sha256,
              reconciled,
              "The authorized adapter failed before the postimage could be proven.",
            );
          } else {
            throw conflict(
              "apply-conflict",
              current,
              file,
              file.after.sha256,
              reconciled,
              "The source changed while the authorized adapter was failing.",
            );
          }
        }
        if (written.sha256 !== file.after.sha256) {
          throw conflict(
            "apply-conflict",
            current,
            file,
            file.after.sha256,
            written,
            "The Designer Action postimage could not be proven after write.",
          );
        }
        current = await advanceEffect(current, index, "apply", "verifying");
        continue;
      }
      if (file.apply.phase === "verifying") {
        if (observed.sha256 !== file.after.sha256) {
          throw conflict(
            "apply-conflict",
            current,
            file,
            file.after.sha256,
            observed,
            "The Designer Action postimage changed before verification.",
          );
        }
        return advanceEffect(current, index, "apply", "verified");
      }
      return current;
    }
  };

  const driveReverseFile = async (
    initial: SourceDesignerMultifileRecordV1,
    index: number,
    field: "rollback" | "undo",
  ): Promise<SourceDesignerMultifileRecordV1> => {
    let current = initial;
    for (;;) {
      const file = current.files[index]!;
      const reverse = file[field];
      const observed = await inspect(current, file);
      const kind: SourceDesignerMultifileRecoveryKind =
        field === "undo" ? "undo-conflict" : "rollback-conflict";

      if (reverse.phase === "pending") {
        if (
          field === "rollback" &&
          file.apply.phase === "pending" &&
          observed.sha256 !== file.before.sha256
        ) {
          throw conflict(
            kind,
            current,
            file,
            file.before.sha256,
            observed,
            "A file not written by this action changed during rollback.",
          );
        }
        if (observed.sha256 !== file.before.sha256 && observed.sha256 !== file.after.sha256) {
          throw conflict(
            kind,
            current,
            file,
            file.after.sha256,
            observed,
            field === "undo"
              ? "The committed postimage changed before undo."
              : "The file changed before exact rollback could begin.",
          );
        }
        current = await advanceEffect(current, index, field, "write-intent");
        continue;
      }

      if (reverse.phase === "write-intent") {
        if (observed.sha256 === file.before.sha256) {
          current = await advanceEffect(current, index, field, "verifying");
          continue;
        }
        if (observed.sha256 !== file.after.sha256) {
          throw conflict(
            kind,
            current,
            file,
            file.after.sha256,
            observed,
            "The source changed while exact reversal was pending.",
          );
        }
        let written: SourceDesignerMultifileObservation;
        try {
          written = validateObservation(
            await options.files.write({
              workspaceId: current.workspaceId,
              path: file.path,
              effectId: reverse.effectId,
              expectedSha256: file.after.sha256,
              bytes: decodeSourceDesignerMultifileImage(file.before),
              ...(current.rootFingerprint
                ? { expectedRootFingerprint: current.rootFingerprint }
                : {}),
            }),
            file.path,
          );
        } catch {
          let reconciled: SourceDesignerMultifileObservation;
          try {
            reconciled = validateObservation(
              await options.files.inspect({
                workspaceId: current.workspaceId,
                path: file.path,
                ...(current.rootFingerprint
                  ? { expectedRootFingerprint: current.rootFingerprint }
                  : {}),
              }),
              file.path,
            );
          } catch {
            throw new SourceDesignerMultifilePortFailure(current, file);
          }
          if (reconciled.sha256 === file.before.sha256) {
            written = reconciled;
          } else {
            throw conflict(
              "inspection-unavailable",
              current,
              file,
              file.before.sha256,
              reconciled,
              "The authorized adapter failed before exact reversal could be proven.",
            );
          }
        }
        if (written.sha256 !== file.before.sha256) {
          throw conflict(
            kind,
            current,
            file,
            file.before.sha256,
            written,
            "The reversed preimage could not be proven after write.",
          );
        }
        current = await advanceEffect(current, index, field, "verifying");
        continue;
      }

      if (reverse.phase === "verifying") {
        if (observed.sha256 !== file.before.sha256) {
          throw conflict(
            kind,
            current,
            file,
            file.before.sha256,
            observed,
            "The reversed preimage changed before verification.",
          );
        }
        return advanceEffect(current, index, field, "verified");
      }
      return current;
    }
  };

  const rollback = async (
    initial: SourceDesignerMultifileRecordV1,
    originalConflict?: SourceDesignerMultifileObservedConflict,
  ): Promise<SourceDesignerMultifileRunResult> => {
    let current = initial;
    if (current.stage !== "rolling-back") {
      current = await checkpoint(current, {
        stage: "rolling-back",
        ...(originalConflict
          ? {
              recovery: {
                kind: originalConflict.kind,
                conflicts: [originalConflict.conflict],
              },
            }
          : {}),
      });
    }
    const auditConflicts = [...(current.recovery?.conflicts ?? [])];
    const conflicts: SourceDesignerMultifileConflictV1[] = [];
    const recoveryKind = current.recovery?.kind ?? originalConflict?.kind;
    for (let index = current.files.length - 1; index >= 0; index -= 1) {
      try {
        current = await driveReverseFile(current, index, "rollback");
      } catch (error) {
        if (error instanceof SourceDesignerMultifilePortFailure) {
          return preservePortFailure(error);
        }
        if (!(error instanceof SourceDesignerMultifileObservedConflict)) throw error;
        current = error.record;
        conflicts.push(error.conflict);
        for (let reviewIndex = index - 1; reviewIndex >= 0; reviewIndex -= 1) {
          const reviewFile = current.files[reviewIndex]!;
          let observed: SourceDesignerMultifileObservation;
          try {
            observed = await inspect(current, reviewFile);
          } catch (reviewError) {
            if (reviewError instanceof SourceDesignerMultifilePortFailure) {
              return preservePortFailure(reviewError);
            }
            throw reviewError;
          }
          const untouched = reviewFile.apply.phase === "pending";
          if (
            observed.sha256 !== reviewFile.before.sha256 &&
            (untouched || observed.sha256 !== reviewFile.after.sha256)
          ) {
            conflicts.push(
              conflict(
                "rollback-conflict",
                current,
                reviewFile,
                untouched ? reviewFile.before.sha256 : reviewFile.after.sha256,
                observed,
                "The file requires conflict review before rollback can continue.",
              ).conflict,
            );
          }
        }
        current = await preserve(current, recoveryKind ?? error.kind, [
          ...auditConflicts,
          ...conflicts,
        ]);
        return result(current);
      }
    }
    for (const file of current.files) {
      let observed: SourceDesignerMultifileObservation;
      try {
        observed = await inspect(current, file);
      } catch (error) {
        if (error instanceof SourceDesignerMultifilePortFailure) {
          return preservePortFailure(error);
        }
        throw error;
      }
      if (observed.sha256 !== file.before.sha256) {
        conflicts.push(
          conflict(
            "rollback-conflict",
            current,
            file,
            file.before.sha256,
            observed,
            "The original preimage was not proven after complete rollback.",
          ).conflict,
        );
      }
    }
    if (conflicts.length > 0) {
      current = await preserve(current, recoveryKind ?? "rollback-conflict", [
        ...auditConflicts,
        ...conflicts,
      ]);
      return result(current);
    }
    current = await checkpoint(current, { stage: "rolled-back" });
    return result(current);
  };

  const apply = async (
    actionId: string,
    guards?: {
      before?: () => Promise<boolean>;
      after?: () => Promise<boolean>;
    },
  ): Promise<SourceDesignerMultifileRunResult> => {
    let current = await options.journal.get(actionId);
    if (!current) throw new Error("Designer Action was not found.");
    if (["committed", "rolled-back", "undone", "recoverable"].includes(current.stage)) {
      return result(current);
    }
    if (current.stage === "undoing") return undo(actionId);
    if (current.stage === "rolling-back") return rollback(current);
    if (
      current.projectId &&
      guards &&
      (current.stage === "applying" || current.stage === "verifying")
    ) {
      return rollback(current);
    }
    if (current.stage === "prepared" && guards?.before && !(await guards.before())) {
      const file = current.files[0]!;
      current = await preserve(current, "authority-revoked", [
        {
          path: file.path,
          expectedSha256: file.before.sha256,
          reason: "The source ownership graph changed before this Designer Action began.",
        },
      ]);
      return result(current);
    }
    if (current.stage === "prepared") current = await checkpoint(current, { stage: "applying" });

    if (current.stage === "applying") {
      for (let index = 0; index < current.files.length; index += 1) {
        try {
          current = await driveApplyFile(current, index);
        } catch (error) {
          if (error instanceof SourceDesignerMultifilePortFailure) {
            return preservePortFailure(error);
          }
          if (!(error instanceof SourceDesignerMultifileObservedConflict)) throw error;
          current = error.record;
          const anyEffectIssued = current.files.some(
            ({ apply: effect }) => effect.phase !== "pending",
          );
          if (!anyEffectIssued) {
            current = await preserve(current, error.kind, [error.conflict]);
            return result(current);
          }
          return rollback(current, error);
        }
      }
      current = await checkpoint(current, { stage: "verifying" });
    }

    if (current.stage !== "verifying") {
      throw new Error("Designer Action apply recovery reached an invalid stage.");
    }
    for (const file of current.files) {
      let observed: SourceDesignerMultifileObservation;
      try {
        observed = await inspect(current, file);
      } catch (error) {
        if (error instanceof SourceDesignerMultifilePortFailure) {
          return preservePortFailure(error);
        }
        throw error;
      }
      if (observed.sha256 !== file.after.sha256) {
        return rollback(
          current,
          conflict(
            "apply-conflict",
            current,
            file,
            file.after.sha256,
            observed,
            "The complete Designer Action postimage changed before commit.",
          ),
        );
      }
    }
    if (guards?.after && !(await guards.after())) {
      const file = current.files[0]!;
      return rollback(
        current,
        new SourceDesignerMultifileObservedConflict(
          "apply-conflict",
          {
            path: file.path,
            expectedSha256: file.after.sha256,
            reason: "The source ownership graph changed while this Designer Action was applying.",
          },
          current,
        ),
      );
    }
    current = await checkpoint(current, { stage: "committed" });
    return result(current);
  };

  const undo = async (actionId: string): Promise<SourceDesignerMultifileRunResult> => {
    let current = await options.journal.get(actionId);
    if (!current) throw new Error("Designer Action was not found.");
    if (["undone", "recoverable"].includes(current.stage)) return result(current);
    if (current.stage !== "committed" && current.stage !== "undoing") {
      throw new Error("Only a committed Designer Action can be undone.");
    }
    if (current.stage === "committed") current = await checkpoint(current, { stage: "undoing" });
    const conflicts: SourceDesignerMultifileConflictV1[] = [];
    for (let index = current.files.length - 1; index >= 0; index -= 1) {
      try {
        current = await driveReverseFile(current, index, "undo");
      } catch (error) {
        if (error instanceof SourceDesignerMultifilePortFailure) {
          return preservePortFailure(error);
        }
        if (!(error instanceof SourceDesignerMultifileObservedConflict)) throw error;
        current = error.record;
        conflicts.push(error.conflict);
        current = await preserve(
          current,
          error.kind === "inspection-unavailable" ? "inspection-unavailable" : "stale-postimage",
          conflicts,
        );
        return result(current);
      }
    }
    for (const file of current.files) {
      let observed: SourceDesignerMultifileObservation;
      try {
        observed = await inspect(current, file);
      } catch (error) {
        if (error instanceof SourceDesignerMultifilePortFailure) {
          return preservePortFailure(error);
        }
        throw error;
      }
      if (observed.sha256 !== file.before.sha256) {
        conflicts.push(
          conflict(
            "undo-conflict",
            current,
            file,
            file.before.sha256,
            observed,
            "The original preimage was not proven after complete undo.",
          ).conflict,
        );
      }
    }
    if (conflicts.length > 0) {
      current = await preserve(current, "stale-postimage", conflicts);
      return result(current);
    }
    current = await checkpoint(current, { stage: "undone" });
    return result(current);
  };

  const runExclusive = <T>(actionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = queues.get(actionId) ?? Promise.resolve();
    const pending = previous.then(operation, operation);
    const tail = pending.then(
      () => undefined,
      () => undefined,
    );
    queues.set(actionId, tail);
    void tail.then(() => {
      if (queues.get(actionId) === tail) queues.delete(actionId);
    });
    return pending;
  };

  const resumeAction = (actionId: string): Promise<SourceDesignerMultifileRunResult> =>
    runExclusive(actionId, async () => {
      const current = await options.journal.get(actionId);
      if (!current) throw new Error("Designer Action was not found.");
      if (current.stage === "rolling-back") return rollback(current);
      if (current.stage === "undoing") return undo(actionId);
      if (["committed", "rolled-back", "undone", "recoverable"].includes(current.stage)) {
        return result(current);
      }
      if (current.stage === "prepared") {
        throw new Error("This Designer Action is still waiting for explicit Apply approval.");
      }
      return apply(actionId);
    });

  return {
    async prepare(
      input: PrepareSourceDesignerMultifileInput,
    ): Promise<SourceDesignerMultifileRecordV1> {
      const requested = collisionSafeFiles(input);
      const existing = await options.journal.get(input.actionId);
      if (existing) {
        const sameRequest =
          existing.workspaceId === input.workspaceId &&
          existing.projectId === input.projectId &&
          existing.chatId === input.chatId &&
          existing.projectRevision === input.projectRevision &&
          existing.sourceNodeId === input.sourceNodeId &&
          existing.sourceSelectionId === input.sourceSelectionId &&
          existing.sourceManifestHash === input.sourceManifestHash &&
          existing.sourcePath === input.sourcePath &&
          existing.sourceStart === input.sourceStart &&
          existing.sourceEnd === input.sourceEnd &&
          existing.sourceLineNumber === input.sourceLineNumber &&
          existing.sourceColumnNumber === input.sourceColumnNumber &&
          existing.sourceComponentName === input.sourceComponentName &&
          existing.sourceSelector === input.sourceSelector &&
          existing.sourceTagName === input.sourceTagName &&
          existing.sourceElementId === input.sourceElementId &&
          existing.sourceAfterManifestHash === input.sourceAfterManifestHash &&
          existing.sourceAfterVersion === input.sourceAfterVersion &&
          existing.sourceAfterStart === input.sourceAfterStart &&
          existing.sourceAfterEnd === input.sourceAfterEnd &&
          existing.sourceAfterLineNumber === input.sourceAfterLineNumber &&
          existing.sourceAfterColumnNumber === input.sourceAfterColumnNumber &&
          existing.label === input.label &&
          existing.files.length === requested.length &&
          existing.files.every(
            (file, index) =>
              file.path === requested[index]!.path &&
              file.before.sha256 === requested[index]!.expectedBeforeSha256 &&
              file.after.sha256 === requested[index]!.after.sha256,
          );
        if (!sameRequest)
          throw new Error("Designer Action ID is already bound to another request.");
        return existing;
      }

      const files: SourceDesignerMultifileFileV1[] = [];
      let rootFingerprint: string | undefined;
      let imageBytes = requested.reduce((total, file) => total + file.after.byteSize, 0);
      for (const requestedFile of requested) {
        const observed = validateObservation(
          await options.files.inspect({
            workspaceId: input.workspaceId,
            path: requestedFile.path,
          }),
          requestedFile.path,
        );
        if (observed.rootFingerprint) {
          if (rootFingerprint && rootFingerprint !== observed.rootFingerprint) {
            throw new Error("The Designer Action workspace root changed during preparation.");
          }
          rootFingerprint = observed.rootFingerprint;
        }
        if (observed.sha256 !== requestedFile.expectedBeforeSha256) {
          throw new Error(`Designer Action source ${requestedFile.path} is stale.`);
        }
        const before = createSourceDesignerMultifileImage(observed.bytes);
        imageBytes += before.byteSize;
        if (imageBytes > SOURCE_DESIGNER_MULTIFILE_MAX_IMAGE_BYTES) {
          throw new Error("Designer Action byte images exceed the transaction limit.");
        }
        files.push({
          path: requestedFile.path,
          before,
          after: requestedFile.after,
          apply: {
            effectId: sourceDesignerMultifileEffectId(
              input.actionId,
              "apply",
              requestedFile.path,
              before.sha256,
              requestedFile.after.sha256,
            ),
            phase: "pending",
          },
          rollback: {
            effectId: sourceDesignerMultifileEffectId(
              input.actionId,
              "rollback",
              requestedFile.path,
              requestedFile.after.sha256,
              before.sha256,
            ),
            phase: "pending",
          },
          undo: {
            effectId: sourceDesignerMultifileEffectId(
              input.actionId,
              "undo",
              requestedFile.path,
              requestedFile.after.sha256,
              before.sha256,
            ),
            phase: "pending",
          },
        });
      }
      const timestamp = now();
      return options.journal.create(
        parseSourceDesignerMultifileRecord({
          version: SOURCE_DESIGNER_MULTIFILE_VERSION,
          actionId: input.actionId,
          workspaceId: input.workspaceId,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.chatId ? { chatId: input.chatId } : {}),
          ...(input.projectRevision === undefined
            ? {}
            : { projectRevision: input.projectRevision }),
          ...(input.sourceNodeId ? { sourceNodeId: input.sourceNodeId } : {}),
          ...(input.sourceSelectionId ? { sourceSelectionId: input.sourceSelectionId } : {}),
          ...(input.sourceManifestHash ? { sourceManifestHash: input.sourceManifestHash } : {}),
          ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
          ...(input.sourceStart === undefined ? {} : { sourceStart: input.sourceStart }),
          ...(input.sourceEnd === undefined ? {} : { sourceEnd: input.sourceEnd }),
          ...(input.sourceLineNumber === undefined
            ? {}
            : { sourceLineNumber: input.sourceLineNumber }),
          ...(input.sourceColumnNumber === undefined
            ? {}
            : { sourceColumnNumber: input.sourceColumnNumber }),
          ...(input.sourceComponentName ? { sourceComponentName: input.sourceComponentName } : {}),
          ...(input.sourceSelector ? { sourceSelector: input.sourceSelector } : {}),
          ...(input.sourceTagName ? { sourceTagName: input.sourceTagName } : {}),
          ...(input.sourceElementId ? { sourceElementId: input.sourceElementId } : {}),
          ...(input.sourceAfterManifestHash
            ? { sourceAfterManifestHash: input.sourceAfterManifestHash }
            : {}),
          ...(input.sourceAfterVersion ? { sourceAfterVersion: input.sourceAfterVersion } : {}),
          ...(input.sourceAfterStart === undefined
            ? {}
            : { sourceAfterStart: input.sourceAfterStart }),
          ...(input.sourceAfterEnd === undefined ? {} : { sourceAfterEnd: input.sourceAfterEnd }),
          ...(input.sourceAfterLineNumber === undefined
            ? {}
            : { sourceAfterLineNumber: input.sourceAfterLineNumber }),
          ...(input.sourceAfterColumnNumber === undefined
            ? {}
            : { sourceAfterColumnNumber: input.sourceAfterColumnNumber }),
          ...(rootFingerprint ? { rootFingerprint } : {}),
          label: input.label,
          revision: 0,
          stage: "prepared",
          files,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    },

    apply(
      actionId: string,
      guards?: {
        before?: () => Promise<boolean>;
        after?: () => Promise<boolean>;
      },
    ): Promise<SourceDesignerMultifileRunResult> {
      return runExclusive(actionId, () => apply(actionId, guards));
    },

    undo(actionId: string): Promise<SourceDesignerMultifileRunResult> {
      return runExclusive(actionId, () => undo(actionId));
    },

    resume: resumeAction,

    revoke(actionId: string, reason: string): Promise<SourceDesignerMultifileRecordV1> {
      return runExclusive(actionId, () =>
        revoke(actionId, reason).then((record) => ({
          status: "recoverable" as const,
          record,
        })),
      ).then(({ record }) => record);
    },

    discardForProjectDeletion(actionId: string, chatId: string): Promise<void> {
      return runExclusive(actionId, async () => {
        const current = await options.journal.get(actionId);
        if (!current) return;
        if (current.chatId !== chatId) {
          throw new Error("Durable Designer Action cascade authority changed.");
        }
        const safeUnwrittenRecovery =
          current.stage === "recoverable" &&
          current.files.every(({ apply: effect }) => effect.phase === "pending");
        if (
          !["prepared", "committed", "rolled-back", "undone"].includes(current.stage) &&
          !safeUnwrittenRecovery
        ) {
          throw new Error(
            "Resolve this Designer Action's source recovery before deleting its project.",
          );
        }
        if (!options.journal.remove) {
          throw new Error("The Designer Action journal cannot complete project deletion.");
        }
        await options.journal.remove(actionId);
      });
    },

    async assertProjectDeletionSafe(actionId: string, chatId: string): Promise<void> {
      const current = await options.journal.get(actionId);
      if (!current) return;
      if (current.chatId !== chatId) {
        throw new Error("Durable Designer Action cascade authority changed.");
      }
      const safeUnwrittenRecovery =
        current.stage === "recoverable" &&
        current.files.every(({ apply: effect }) => effect.phase === "pending");
      if (
        !["prepared", "committed", "rolled-back", "undone"].includes(current.stage) &&
        !safeUnwrittenRecovery
      ) {
        throw new Error(
          "Resolve this Designer Action's source recovery before deleting its project.",
        );
      }
    },

    async resumeInterrupted(): Promise<SourceDesignerMultifileRunResult[]> {
      const records = await options.journal.listInterrupted();
      const resumed: SourceDesignerMultifileRunResult[] = [];
      for (const record of records) resumed.push(await resumeAction(record.actionId));
      return resumed;
    },
  };
}

export type SourceDesignerMultifileCoordinator = ReturnType<
  typeof createSourceDesignerMultifileCoordinator
>;
