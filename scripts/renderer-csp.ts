import type { Plugin } from "vite";

/** Connect destinations remain independent of development code-loading privileges. */
export function productionRendererHtml(html: string): string {
  let policies = 0;
  const result = html.replace(/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]+)("\s*\/?>)/giu, (_match, head: string, policy: string, tail: string) => {
    policies += 1;
    const directives = policy.split(";").map(directive => {
      const [name, ...sources] = directive.trim().split(/\s+/u);
      if (name !== "script-src" && name !== "style-src") return directive.trim();
      return [name, ...sources.filter(source => !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::[^/]*)?(?:\/.*)?$/u.test(source))].join(" ");
    });
    return `${head}${directives.join("; ")}${tail}`;
  });
  if (policies !== 1) throw new Error("Every shipped renderer page must declare exactly one CSP.");
  return result;
}

export function productionRendererCsp(): Plugin {
  return {
    name: "aiden-production-renderer-csp",
    apply: "build",
    transformIndexHtml: { order: "pre", handler: productionRendererHtml },
  };
}
