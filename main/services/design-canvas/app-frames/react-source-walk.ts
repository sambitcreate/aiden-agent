// React source mapping for live app frames (design mode v2 Phase 3a, D14).
//
// The walk runs inside the app's page (the v2 bridge embeds this source), so
// it is a plain script string, evaluated to an object with two functions:
//
// - `walk(element, origin, fetchText)` finds the element's React fiber, the
//   nearest component above it and up to 8 owners (`_debugOwner`), then its
//   source: React <= 18's `_debugSource`, or React 19's `_debugStack` mapped
//   through the module's inline source map (fetched from the frame's own
//   origin), or a `data-aiden-src` stamp on the element or an ancestor.
// - `decodeSourceMapLine(map, line, column)` maps a 1-based generated line and
//   column to `{source, line}` (1-based) through a v3 map's `mappings`.
//
// Everything it returns is page-reported and untrusted (S11): the page runs
// first and can replace any global or fiber. The renderer bounds and checks
// what the bridge posts; nothing security-related reads it.

export const REACT_SOURCE_WALK_SOURCE = String.raw`(function () {
  "use strict";
  var MAX_OWNERS = 8;
  var MAX_NAME = 120;
  var MAX_PATH = 512;
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var REACT_FRAME = /(?:jsxDEV|jsx-dev-runtime|jsx_dev_runtime|jsx-runtime|react-dom|react_dom|\/deps\/|\/node_modules\/)/;

  function decodeSegment(text) {
    var values = [];
    var value = 0;
    var shift = 0;
    for (var i = 0; i < text.length; i++) {
      var digit = B64.indexOf(text.charAt(i));
      if (digit < 0) return null;
      value += (digit & 31) << shift;
      if (digit & 32) {
        shift += 5;
      } else {
        var negative = value & 1;
        value >>>= 1;
        values.push(negative ? -value : value);
        value = 0;
        shift = 0;
      }
    }
    return shift === 0 ? values : null;
  }

  function decodeSourceMapLine(map, line, column) {
    if (!map || typeof map.mappings !== "string" || !Array.isArray(map.sources)) return null;
    if (!(line >= 1) || !(column >= 1)) return null;
    var lines = map.mappings.split(";");
    if (line > lines.length) return null;
    var source = 0;
    var sourceLine = 0;
    var sourceColumn = 0;
    var name = 0;
    var best = null;
    for (var l = 0; l < line; l++) {
      var generated = 0;
      var segments = lines[l] ? lines[l].split(",") : [];
      for (var s = 0; s < segments.length; s++) {
        var values = decodeSegment(segments[s]);
        if (!values || values.length === 0) continue;
        generated += values[0];
        if (values.length >= 4) {
          source += values[1];
          sourceLine += values[2];
          sourceColumn += values[3];
          if (values.length >= 5) name += values[4];
          if (l === line - 1 && generated <= column - 1) {
            if (!best || generated >= best.generated) best = { generated: generated, source: source, line: sourceLine };
          }
        }
      }
    }
    if (!best || typeof map.sources[best.source] !== "string") return null;
    return { source: map.sources[best.source], line: best.line + 1 };
  }

  function fiberOf(element) {
    for (var node = element; node; node = node.parentElement) {
      var keys;
      try { keys = Object.keys(node); } catch (error) { return null; }
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf("__reactFiber$") === 0) return node[keys[i]];
      }
    }
    return null;
  }

  function nameOf(type) {
    if (!type) return null;
    if (typeof type === "function") return type.displayName || type.name || null;
    if (typeof type === "object") {
      if (typeof type.displayName === "string") return type.displayName;
      if (type.render) return nameOf(type.render);
      if (type.type) return nameOf(type.type);
    }
    return null;
  }

  function bounded(name) {
    return typeof name === "string" && name ? name.slice(0, MAX_NAME) : null;
  }

  function relativePath(origin, url) {
    var parsed;
    try { parsed = new URL(url); } catch (error) { return null; }
    if (parsed.origin !== origin) return null;
    var path = decodeURIComponent(parsed.pathname);
    if (path.indexOf("/@fs/") === 0 || path.indexOf("/@id/") === 0 || path.indexOf("/node_modules/") === 0) return null;
    if (path.split("/").indexOf("..") >= 0 || path.indexOf("\\") >= 0) return null;
    path = path.replace(/^\/+/, "");
    if (!path || path.length > MAX_PATH) return null;
    return path;
  }

  function stackFrames(stack) {
    var frames = [];
    var lines = String(stack || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var match = /(?:\(|@|at )((?:https?|file):\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/.exec(lines[i]);
      if (match) frames.push({ url: match[1], line: Number(match[2]), column: Number(match[3]) });
    }
    return frames;
  }

  function inlineMap(text) {
    var marker = "sourceMappingURL=data:application/json;";
    var at = text.lastIndexOf(marker);
    if (at < 0) return null;
    var rest = text.slice(at + marker.length).split(/\s/)[0];
    var comma = rest.indexOf(",");
    if (comma < 0) return null;
    var meta = rest.slice(0, comma);
    var body = rest.slice(comma + 1);
    try {
      var json = /(^|;)base64$/.test(meta) ? atob(body) : decodeURIComponent(body);
      return JSON.parse(json);
    } catch (error) {
      return null;
    }
  }

  function stamp(element) {
    for (var node = element; node && node.getAttribute; node = node.parentElement) {
      var value = node.getAttribute("data-aiden-src");
      if (!value) continue;
      // 3d (S111): "ws:" marks a design app's stamp as workspace-relative, never
      // absolute or climbing out; an unprefixed stamp is the page's own path.
      var workspace = value.indexOf("ws:") === 0;
      if (workspace) value = value.slice(3);
      var match = /^(.*):(\d+)$/.exec(value);
      var found = match ? { path: match[1], line: Number(match[2]) } : { path: value };
      if (workspace) {
        if (!found.path || found.path.charAt(0) === "/" || found.path.split("/").indexOf("..") >= 0 || found.path.indexOf("\\") >= 0) return null;
        found.base = "workspace";
      }
      return found;
    }
    return null;
  }

  function fromStack(fiber, origin, fetchText) {
    var stack = null;
    try { stack = fiber && fiber._debugStack ? fiber._debugStack.stack : null; } catch (error) { stack = null; }
    if (!stack) return Promise.resolve(null);
    var frames = stackFrames(stack);
    var frame = null;
    for (var i = 0; i < frames.length; i++) {
      if (REACT_FRAME.test(frames[i].url)) continue;
      frame = frames[i];
      break;
    }
    if (!frame) return Promise.resolve(null);
    var path = relativePath(origin, frame.url);
    if (!path) return Promise.resolve(null);
    return Promise.resolve()
      .then(function () { return fetchText(frame.url); })
      .then(function (text) {
        var map = typeof text === "string" ? inlineMap(text) : null;
        var mapped = map ? decodeSourceMapLine(map, frame.line, frame.column) : null;
        return mapped ? { path: path, line: mapped.line } : { path: path };
      })
      .catch(function () { return { path: path }; });
  }

  function walk(element, origin, fetchText) {
    var result = { owners: [] };
    var host = fiberOf(element);
    var component = host;
    try {
      while (component && typeof component.type !== "function" && !(component.type && typeof component.type === "object" && nameOf(component.type))) {
        component = component["return"];
      }
    } catch (error) {
      component = null;
    }
    var name = component ? bounded(nameOf(component.type)) : null;
    if (name) result.component = name;
    try {
      var seen = 0;
      for (var owner = component ? component._debugOwner : null; owner && seen < 32 && result.owners.length < MAX_OWNERS; owner = owner._debugOwner, seen++) {
        var ownerName = bounded(nameOf(owner.type));
        if (ownerName) result.owners.push(ownerName);
      }
    } catch (error) {}
    var legacy = null;
    try { legacy = (host && host._debugSource) || (component && component._debugSource) || null; } catch (error) { legacy = null; }
    if (legacy && typeof legacy.fileName === "string") {
      // A URL on the frame's origin, or a relative path. An absolute file
      // system path can't be placed under the app root here, so it gives none.
      var legacyPath = null;
      if (/^[a-z][a-z0-9+.-]*:/i.test(legacy.fileName)) legacyPath = relativePath(origin, legacy.fileName);
      else if (legacy.fileName.charAt(0) !== "/" && legacy.fileName.split("/").indexOf("..") < 0 && legacy.fileName.indexOf("\\") < 0 && legacy.fileName.length <= MAX_PATH) legacyPath = legacy.fileName;
      if (legacyPath) {
        result.path = legacyPath;
        if (Number.isInteger(legacy.lineNumber) && legacy.lineNumber > 0) result.line = legacy.lineNumber;
        return Promise.resolve(result);
      }
    }
    return fromStack(host, origin, fetchText).then(function (source) {
      var found = source || stamp(element);
      if (found && found.path) {
        result.path = found.path;
        if (found.line) result.line = found.line;
        if (found.base) result.base = found.base;
      }
      return result;
    });
  }

  return { walk: walk, decodeSourceMapLine: decodeSourceMapLine };
})()`;

type SourceMapLike = { mappings: string; sources: string[] };
export type ReactSourceResult = {
  component?: string;
  owners: string[];
  path?: string;
  line?: number;
  /** 3d (S111): `path` is relative to the workspace, from a design app's `ws:` stamp; otherwise to the app root. */
  base?: "workspace";
};
type ReactSourceWalk = {
  walk(element: unknown, origin: string, fetchText: (url: string) => Promise<string>): Promise<ReactSourceResult>;
  decodeSourceMapLine(map: SourceMapLike, line: number, column: number): { source: string; line: number } | null;
};

let evaluated: ReactSourceWalk | undefined;
function instance(): ReactSourceWalk {
  evaluated ??= new Function(`return ${REACT_SOURCE_WALK_SOURCE};`)() as ReactSourceWalk;
  return evaluated;
}

/** The decoder the in-page walk uses, for tests and main-side checks. */
export function decodeSourceMapLine(map: SourceMapLike, line: number, column: number): { source: string; line: number } | null {
  return instance().decodeSourceMapLine(map, line, column);
}

/** The in-page walk, evaluated here so tests can run it against a fake DOM. */
export function walkReactSource(element: unknown, origin: string, fetchText: (url: string) => Promise<string>): Promise<ReactSourceResult> {
  return instance().walk(element, origin, fetchText);
}
