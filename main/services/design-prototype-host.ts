import { randomUUID } from "node:crypto";
import { GENERATIVE_UI_EXPORT_CSP, GENERATIVE_UI_IFRAME_SANDBOX } from "../../renderer/shared/generative-ui.js";
import type { DesignPrototypeEdgeV1 } from "../../renderer/shared/design-prototype.js";
import { wrapGenerativeUiHtml } from "./generative-ui-html.js";

export interface PrototypeHostScreen { mediaId: string; html: string }
const json = (value: unknown) => JSON.stringify(value).replace(/</gu, "\\u003c");
export function prototypeHostDocument(): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src about:; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}iframe{display:block}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}</style><iframe title="Design prototype" sandbox="${GENERATIVE_UI_IFRAME_SANDBOX}" referrerpolicy="no-referrer"></iframe>`;
}

/** Runs in an isolated world: generated scripts cannot replace verification built-ins. */
export function prototypeCheckScript(edge: DesignPrototypeEdgeV1): string {
  return `(() => { const e=${json(edge)}; const matches=document.querySelectorAll(e.selector); if(matches.length!==1)throw Error('Edge requires exactly one source element'); const el=matches[0]; const r=el.getBoundingClientRect(); const s=getComputedStyle(el); if(!r.width||!r.height||s.visibility==='hidden'||s.display==='none'||s.pointerEvents==='none'||el.disabled||el.readOnly)throw Error('Source must be visible and enabled'); if(e.trigger==='submit'&&el.tagName!=='FORM')throw Error('Submit source must be a form'); if(e.trigger==='change'&&!['INPUT','SELECT','TEXTAREA'].includes(el.tagName))throw Error('Change source must be an input'); if(e.trigger==='click'&&!el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Source is occluded'); const focus=e.trigger==='submit'?(el.querySelector('button:not([type]):not(:disabled),button[type=submit]:not(:disabled),input[type=submit]:not(:disabled),input:not([type]):not(:disabled),input[type=text]:not(:disabled),input[type=search]:not(:disabled),input[type=email]:not(:disabled),input[type=url]:not(:disabled),input[type=tel]:not(:disabled),input[type=password]:not(:disabled),input[type=number]:not(:disabled)')):el; if(!focus||typeof focus.focus!=='function')throw Error('Source has no keyboard target'); focus.focus(); if(document.activeElement!==focus)throw Error('Source is not keyboard focusable'); const name=el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||el.labels?.[0]?.textContent||''; if(!String(name).trim())throw Error('Source has no accessible label'); return e.id; })()`;
}

export async function openPrototypeHost(screens: readonly PrototypeHostScreen[], edges: readonly DesignPrototypeEdgeV1[], options: { verify: boolean; entryMediaId?: string; onClosed?: () => void; beforeNavigate?: () => Promise<void> }) {
  const { BrowserWindow, session } = await import("electron");
  const partition = `prototype-${randomUUID()}`;
  const isolatedSession = session.fromPartition(partition, { cache: false });
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({ show: false, width: 1100, height: 800, title: "Design prototype", webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false, spellcheck: false } });
  const hostUrl = `data:text/html;charset=utf-8,${encodeURIComponent(prototypeHostDocument())}`;
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    const ownedHost = details.resourceType === "mainFrame" && details.url === hostUrl;
    const guest = details.resourceType === "subFrame" && details.url === "about:srcdoc";
    const inlineImage = details.resourceType === "image" && details.url.length <= 1024 * 1024 && /^(?:data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,]|blob:)/iu.test(details.url);
    callback({ cancel: !ownedHost && !guest && !inlineImage });
  });
  isolatedSession.on("will-download", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-frame-navigate", (event) => { if (event.url !== "about:srcdoc") event.preventDefault(); });
  const cap = randomUUID();
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  const lifetime = setTimeout(() => close(), 15 * 60_000);
  const close = () => { if (stopped) return; stopped = true; clearTimeout(lifetime); if (interval) clearInterval(interval); if (!window.isDestroyed()) window.destroy(); options.onClosed?.(); };
  window.on("closed", close);
  async function bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { if (!window.isDestroyed()) window.webContents.forcefullyCrashRenderer(); close(); reject(new Error("Prototype sandbox check timed out.")); }, 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  try {
    window.webContents.debugger.attach("1.3");
    const guestSessions = new Map<string, string>();
    window.webContents.debugger.on("message", (_event, method, params) => {
      if (method === "Target.attachedToTarget" && params.targetInfo.type === "iframe") guestSessions.set(params.sessionId, params.targetInfo.targetId);
      if (method === "Target.detachedFromTarget") guestSessions.delete(params.sessionId);
    });
    await bounded(window.webContents.debugger.sendCommand("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }));
    const isolated = async (code: string, worldName: string): Promise<unknown> => {
      const sessionId = guestSessions.size === 1 ? [...guestSessions.keys()][0] : undefined;
      const tree = await bounded(window.webContents.debugger.sendCommand("Page.getFrameTree", {}, sessionId));
      const children = tree.frameTree.childFrames ?? [];
      const frameId = sessionId ? tree.frameTree.frame.id : children.length === 1 ? children[0].frame.id : undefined;
      if (!frameId || window.webContents.mainFrame.frames.length !== 1) throw new Error("Prototype requires one isolated guest.");
      const context = await bounded(window.webContents.debugger.sendCommand("Page.createIsolatedWorld", { frameId, worldName }, sessionId));
      const result = await bounded(window.webContents.debugger.sendCommand("Runtime.evaluate", { expression: code, contextId: context.executionContextId, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId));
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Prototype sandbox check failed.");
      return result.result.value;
    };
    await bounded(window.loadURL(hostUrl));
    await bounded(window.webContents.executeJavaScript(`window.__prototypeQueue=[];window.addEventListener('message',event=>{const frame=document.querySelector('iframe');if(event.source!==frame.contentWindow||event.data?.cap!==${json(cap)}||typeof event.data.edge!=='string')return;window.__prototypeQueue.push(event.data.edge);if(window.__prototypeQueue.length>1)window.__prototypeQueue.shift()})`));
    const install = async (mediaId: string) => {
      const screen = screens.find((item) => item.mediaId === mediaId);
      if (!screen) throw new Error("Prototype destination is unavailable.");
      const guest = wrapGenerativeUiHtml(screen.html, "Prototype").replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/u, `<meta http-equiv="Content-Security-Policy" content="${GENERATIVE_UI_EXPORT_CSP}">`);
      await bounded(window.webContents.executeJavaScript(`new Promise(resolve=>{const frame=document.querySelector('iframe');frame.onload=()=>resolve(true);frame.srcdoc=${json(guest)}})`));
      const frames = window.webContents.mainFrame.frames;
      if (frames.length !== 1) throw new Error("Prototype requires exactly one isolated frame.");
      return frames[0]!;
    };
    const input = (method: string, params: Record<string, unknown>) => bounded(window.webContents.debugger.sendCommand(method, params, guestSessions.size === 1 ? [...guestSessions.keys()][0] : undefined));
    const bridge = async (mediaId: string) => {
      const local = edges.filter((edge) => edge.fromMediaId === mediaId);
      await isolated(`for(const edge of ${json(local)}){const el=document.querySelector(edge.selector);if(!el)continue;const route=event=>{if(!event.isTrusted)return;event.preventDefault();parent.postMessage({cap:${json(cap)},edge:edge.id},'*')};el.addEventListener(edge.trigger,event=>{if(edge.trigger==='keydown'&&event.key!==edge.key)return;route(event)},true);if(edge.trigger==='submit'&&el.tagName==='FORM'){el.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.target.disabled&&!event.target.isContentEditable&&event.target.form===el&&event.target.matches('button:not([type]),button[type=submit],input[type=submit],input:not([type]),input[type=text],input[type=search],input[type=email],input[type=url],input[type=tel],input[type=password],input[type=number]')&&el.checkValidity())route(event)},true);el.addEventListener('click',event=>{const target=event.target.closest('button:not([type]),button[type="submit"],input[type="submit"]');if(target&&target.form===el&&el.checkValidity())route(event)},true)}}`, "prototype-player");
    };
    if (options.verify) {
      const passedEdgeIds: string[] = [];
      for (const screen of screens) await install(screen.mediaId);
      const key = async (value: string) => {
        const keyCode = value === "Enter" ? 13 : value === "Tab" ? 9 : value === " " ? 32 : value.startsWith("Arrow") ? ({ ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 } as Record<string, number>)[value] : 27;
        for (const type of ["keyDown", "keyUp"]) await input("Input.dispatchKeyEvent", { type, key: value, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      };
      for (const edge of edges) {
        await install(edge.fromMediaId);
        if (await isolated(prototypeCheckScript(edge), "prototype-verify") !== edge.id) throw new Error("Invalid prototype check result.");
        await bridge(edge.fromMediaId);
        await bounded(window.webContents.executeJavaScript("window.__prototypeQueue=[]"));
        const point = await isolated(`(()=>{const el=document.querySelector(${json(edge.selector)});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,tag:el.tagName,type:el.type}})()`, "prototype-verify") as { x: number; y: number; tag: string; type: string };
        const click = async () => { for (const type of ["mousePressed", "mouseReleased"]) await input("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 }); };
        if (edge.trigger === "click") await click();
        else if (edge.trigger === "keydown") await key(edge.key!);
        else if (edge.trigger === "submit") await key("Enter");
        else if (["checkbox", "radio"].includes(point.type)) await click();
        else if (point.tag === "SELECT") { await key("ArrowDown"); await key("Tab"); }
        else { await input("Input.insertText", { text: "prototype check" }); await key("Tab"); }
        const routed = await bounded(window.webContents.executeJavaScript("new Promise(resolve=>{const timer=setInterval(()=>{const id=window.__prototypeQueue.shift();if(id){clearInterval(timer);resolve(id)}},20)})")).catch(() => { throw new Error(`Prototype ${edge.trigger} input did not route edge ${edge.id}.`); });
        if (routed !== edge.id) throw new Error("Prototype input did not route the exact verified edge.");
        await install(edge.toMediaId);
        passedEdgeIds.push(edge.id);
      }
      const windowId = window.id;
      close();
      return { passedEdgeIds, windowId, close };
    }
    let current = options.entryMediaId ?? screens[0]?.mediaId;
    if (!current) throw new Error("Prototype has no screens.");
    const show = async (mediaId: string, fade = false) => {
      await options.beforeNavigate?.();
      await install(mediaId);
      await bridge(mediaId);
      await isolated("document.querySelector('button,input,select,textarea,[tabindex]')?.focus()", "prototype-player");
      current = mediaId;
      if (fade) await bounded(window.webContents.executeJavaScript("matchMedia('(prefers-reduced-motion:reduce)').matches?true:document.querySelector('iframe').animate([{opacity:0},{opacity:1}],{duration:120}).finished.then(()=>true)"));
    };
    await show(current);
    window.show();
    let busy = false;
    interval = setInterval(() => {
      if (busy || stopped) return;
      busy = true;
      void (async () => {
        const edgeId = await bounded(window.webContents.executeJavaScript("window.__prototypeQueue.shift()"));
        const edge = edges.find((item) => item.id === edgeId && item.fromMediaId === current);
        if (edge) await show(edge.toMediaId, edge.transition === "fade");
      })().catch(close).finally(() => { busy = false; });
    }, 80);
    return { passedEdgeIds: [], windowId: window.id, close };
  } catch (error) { close(); throw error; }
}
