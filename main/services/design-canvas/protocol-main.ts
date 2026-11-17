// Production wiring for the aiden-design:// protocol. No logic here: the
// request handler is tested directly in protocol.test.ts.
import { protocol } from "electron";
import { designGrants } from "./main.js";
import { registerDesignProtocol } from "./protocol.js";

export function startDesignProtocol(): void {
  registerDesignProtocol({ protocol, grants: designGrants });
}
