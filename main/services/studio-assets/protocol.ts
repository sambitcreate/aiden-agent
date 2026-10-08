import { protocol } from "electron";
import { STUDIO_ASSET_SCHEME } from "../custom-schemes-core.js";

let installed = false;

/** Install the `aiden-asset:` handler once, after the store has initialized. */
export function registerStudioAssetProtocol(handler: (request: Request) => Promise<Response>): void {
  if (installed) return;
  protocol.handle(STUDIO_ASSET_SCHEME, handler);
  installed = true;
}
