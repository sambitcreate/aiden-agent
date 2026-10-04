import type Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import type { PeerOperation } from "../../renderer/shared/peer-operation.js";

const operationIds: Record<PeerOperation["operation"], string> = {
  server: "getServer",
  summaries: "listChatSummaries",
  workspaces: "listWorkspaces",
  models: "listModels",
  chat: "getChat",
  roots: "listWorkspaceBrowserRoots",
  children: "listWorkspaceBrowserChildren",
  stream: "getStream",
  approval: "getStreamApproval",
  files: "listWorkspaceFiles",
  file: "readWorkspaceFile",
  git: "reviewGitWorkspace",
  createChat: "createChat",
  send: "startTurn",
  renameChat: "updateChat",
  deleteChat: "deleteChat",
  cancel: "cancelStream",
  respondApproval: "respondApproval",
  selectFolder: "createWorkspaceSelection",
  createWorkspace: "createWorkspace",
};
type PeerProtocol = typeof import("../../protocol/aiden-remote/v1/openapi.json");
interface PeerContract {
  ajv: Ajv2020;
  protocol: PeerProtocol;
}

// The checked-in OpenAPI contract (~289 KB) and its validator load on the
// first peer response rather than on the main-process startup path.
let contractLoading: Promise<PeerContract> | null = null;
function peerContract(): Promise<PeerContract> {
  contractLoading ??= Promise.all([
    import("ajv/dist/2020.js"),
    import("ajv-formats"),
    import("../../protocol/aiden-remote/v1/openapi.json"),
  ]).then(
    ([{ default: Ajv }, { default: addFormats }, { default: protocol }]) => {
      const ajv = new Ajv({
        strict: false,
        allErrors: false,
        validateFormats: true,
      });
      addFormats(ajv);
      ajv.addSchema({
        $id: "urn:aiden:peer",
        components: protocol.components,
        paths: protocol.paths,
      });
      return { ajv, protocol };
    },
    (error: unknown) => {
      contractLoading = null;
      throw error;
    },
  );
  return contractLoading;
}

const validators = new Map<string, ValidateFunction | null>();
async function validator(operation: string): Promise<ValidateFunction | null> {
  if (!Object.prototype.hasOwnProperty.call(operationIds, operation))
    throw new Error("Unsupported peer operation.");
  if (validators.has(operation)) return validators.get(operation)!;
  const { ajv, protocol } = await peerContract();
  if (validators.has(operation)) return validators.get(operation)!;
  const id = operationIds[operation as PeerOperation["operation"]];
  for (const [path, methods] of Object.entries(protocol.paths)) {
    for (const [method, endpoint] of Object.entries(methods)) {
      if (
        !endpoint ||
        typeof endpoint !== "object" ||
        !("operationId" in endpoint) ||
        endpoint.operationId !== id
      )
        continue;
      const responses = (endpoint as { responses: Record<string, unknown> })
        .responses;
      const status = Object.keys(responses).find((code) =>
        /^2\d\d$/u.test(code),
      );
      if (!status) break;
      if (status === "204") {
        validators.set(operation, null);
        return null;
      }
      // Compile from the checked-in protocol, including its local component references.
      const pointer = path.replace(/~/gu, "~0").replace(/\//gu, "~1");
      const result = ajv.compile({
        $ref: `urn:aiden:peer#/paths/${pointer}/${method}/responses/${status}/content/application~1json/schema`,
      });
      validators.set(operation, result);
      return result;
    }
  }
  throw new Error("Missing peer response contract.");
}

/** Validate the entire protocol envelope; content fields are not scanned for secret-like words. */
export async function validatePeerResponse(
  operation: string,
  value: unknown,
): Promise<void> {
  let nodes = 0;
  let bytes = 0;
  const visit = (node: unknown, depth: number): void => {
    if (++nodes > 50_000 || depth > 64)
      throw new Error("Peer response exceeds structural limits.");
    if (typeof node === "string") bytes += Buffer.byteLength(node);
    else if (Array.isArray(node)) {
      if (node.length > 4000)
        throw new Error("Peer response array exceeds its limit.");
      for (const child of node) visit(child, depth + 1);
    } else if (node && typeof node === "object") {
      const entries = Object.entries(node);
      if (entries.length > 256)
        throw new Error("Peer response object exceeds its limit.");
      for (const [key, child] of entries) {
        bytes += Buffer.byteLength(key);
        visit(child, depth + 1);
      }
    }
    if (bytes > 1_048_576)
      throw new Error("Peer response exceeds its byte limit.");
  };
  visit(value, 0);
  const check = await validator(operation);
  if (check === null ? value !== undefined : !check(value))
    throw new Error("Invalid peer response contract.");
}
