import { botConnectorForegroundLifetime, botConnectorInventoryServer, botConnectorInventoryCacheOnly, withBotConnectorCachedInventoryScope, withBotConnectorInventoryScope } from "./bot-connector-inventory-scope.js";

/** A watch never creates or joins an unapproved pending transport, including during model assembly. */
export async function existingOrConnectMcpClient<T>(ports: { peek(): T | undefined; connect(): Promise<T> }): Promise<T> {
  if (!botConnectorInventoryServer()) return ports.connect();
  const live = ports.peek();
  if (!live) throw new Error("Connect this app in the foreground before the watch uses it.");
  return live;
}

/** A returned callback retains the watch's transport boundary after its assembly scope exits. */
export function bindMcpConnectorInventoryScope<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
  const selected = botConnectorInventoryServer(),cached=botConnectorInventoryCacheOnly();
  return selected === undefined ? operation : (...args) => (cached?withBotConnectorCachedInventoryScope:withBotConnectorInventoryScope)(selected, () => operation(...args));
}

/** A foreground-attested source identity belongs to one approved client and config epoch. */
export class McpConnectorSourceAttestations {
  private readonly values=new WeakMap<object,{epoch:number;fingerprint:string}>();
  attest(client:object,epoch:number,fingerprint:string,assertCurrent:()=>unknown):void{
    assertCurrent(); const lifetime=botConnectorForegroundLifetime();
    if(!lifetime||!/^[a-f0-9]{64}$/u.test(fingerprint))throw new Error("Connector attestation requires a current foreground owner action.");
    lifetime.signal.throwIfAborted();this.values.set(client,{epoch,fingerprint});
  }
  get(client:object,epoch:number,assertCurrent:()=>unknown):string|undefined{
    assertCurrent();const value=this.values.get(client);return value?.epoch===epoch?value.fingerprint:undefined;
  }
}

/** Source-derived model assembly never enters normal admission's global cleanup queue. */
export async function admitMcpConnectorDiscovery<T>(ports:{
  serverId:string;
  assertExisting():void;
  assertConfigured():Promise<void>;
  runExisting():Promise<T>;
  normalAdmission():Promise<T>;
}):Promise<T>{
  const selected=botConnectorInventoryServer();
  if(selected===undefined)return ports.normalAdmission();
  if(selected!==ports.serverId)throw new Error("Watch work cannot inspect another connector.");
  ports.assertExisting();await ports.assertConfigured();ports.assertExisting();
  return ports.runExisting();
}
