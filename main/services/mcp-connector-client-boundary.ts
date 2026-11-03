import { botConnectorInventoryServer, withBotConnectorInventoryScope } from "./bot-connector-inventory-scope.js";

/** A watch never creates or joins an unapproved pending transport, including during model assembly. */
export async function existingOrConnectMcpClient<T>(ports: { peek(): T | undefined; connect(): Promise<T> }): Promise<T> {
  if (!botConnectorInventoryServer()) return ports.connect();
  const live = ports.peek();
  if (!live) throw new Error("Connect this app in the foreground before the watch uses it.");
  return live;
}

/** A returned callback retains the watch's transport boundary after its assembly scope exits. */
export function bindMcpConnectorInventoryScope<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
  const selected = botConnectorInventoryServer();
  return selected === undefined ? operation : (...args) => withBotConnectorInventoryScope(selected, () => operation(...args));
}
