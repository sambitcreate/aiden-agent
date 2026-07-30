export async function commitOwnedMutation(input: {
  isCurrent: () => boolean;
  publish: () => Promise<void>;
  rollback: () => Promise<void>;
}): Promise<void> {
  if (!input.isCurrent()) {
    throw new Error("MCP OAuth credentials changed while this operation was in progress.");
  }
  try {
    await input.publish();
  } catch (publishError) {
    try {
      await input.rollback();
    } catch (rollbackError) {
      throw new Error(
        `MCP OAuth publication and rollback both failed: ${
          publishError instanceof Error ? publishError.message : String(publishError)
        }; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    throw publishError;
  }
  if (input.isCurrent()) return;
  try {
    await input.rollback();
  } catch (rollbackError) {
    throw new Error(
      `MCP OAuth ownership changed after publication and rollback failed: ${
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      }`,
    );
  }
  throw new Error("MCP OAuth credentials changed while this operation was in progress.");
}
