import { DesignGrantRegistry } from "./grants.js";

/** Live `aiden-design://` grants. Memory only: a restart ends every grant. */
export const designGrants = new DesignGrantRegistry();
