import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { DOMImplementation } from "@xmldom/xmldom";
import * as React from "react";

import {
  ComposerSlashPalette,
  ComposerSlashPalettePresence,
} from "../components/composer-slash-palette.js";
import {
  parseSkillCatalog,
  SLASH_LIMITS,
  type SkillCatalogEntry,
} from "../shared/slash-commands.js";
import {
  deriveSlashSession,
  rankSlashResults,
  updateSlashSessionTracker,
} from "./slash-command-core.js";

function invocationId(index: number): string {
  return `sk1_${index.toString(36).padStart(43, "0")}`;
}

function fullCatalog(): SkillCatalogEntry[] {
  return Array.from({ length: SLASH_LIMITS.catalogEntries }, (_, index) => {
    const entry: SkillCatalogEntry = {
      invocationId: invocationId(index),
      name: `Skill ${index.toString().padStart(3, "0")}${"N".repeat(
        SLASH_LIMITS.safeNameCharacters - 9,
      )}`,
      description: `${"D".repeat(SLASH_LIMITS.safeDescriptionCharacters - 3)}${index
        .toString()
        .padStart(3, "0")}`,
      source: index % 3 === 0 ? "configured" : index % 3 === 1 ? "workspace" : "global",
      available: index % 11 !== 0,
    };
    return entry.available
      ? entry
      : { ...entry, unavailableReason: "Unavailable for this workspace." };
  });
}

interface MountedDom {
  container: HTMLElement;
  restore: () => void;
}

function installMountedDom(): MountedDom {
  const document = new DOMImplementation().createDocument(
    null,
    "html",
    null,
  ) as unknown as Document;
  const body = document.createElement("body");
  const container = document.createElement("div");
  Object.defineProperty(document.documentElement, "dataset", {
    configurable: true,
    value: {},
  });
  body.appendChild(container);
  document.documentElement.appendChild(body);

  const elementPrototype = Object.getPrototypeOf(document.createElement("div")) as HTMLElement &
    Record<string, unknown>;
  elementPrototype.addEventListener = () => undefined;
  elementPrototype.removeEventListener = () => undefined;
  elementPrototype.scrollIntoView = () => undefined;
  Object.defineProperty(elementPrototype, "style", {
    configurable: true,
    get: () => ({}),
  });
  const documentPrototype = Object.getPrototypeOf(document) as Document;
  documentPrototype.addEventListener = () => undefined;
  documentPrototype.removeEventListener = () => undefined;
  Object.defineProperty(document, "body", { configurable: true, value: body });

  const sideEffects = { ipc: 0, mcp: 0, network: 0 };
  const window = {
    document,
    event: undefined,
    HTMLIFrameElement: class HTMLIFrameElement {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (_callback: TimerHandler, _delay?: number) => 1,
    clearTimeout: (_timer?: number) => undefined,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    },
    cancelAnimationFrame: () => undefined,
    fetch: () => {
      sideEffects.network += 1;
      throw new Error("Slash palette rendering attempted a network request.");
    },
    aidenAPI: {
      ipc: new Proxy(
        {},
        {
          get:
            (_target, method) =>
            (...args: unknown[]) => {
              const channel = String(args[0] ?? method).toLocaleLowerCase();
              if (channel.includes("mcp")) sideEffects.mcp += 1;
              else sideEffects.ipc += 1;
              throw new Error("Slash palette rendering attempted an IPC request.");
            },
        },
      ),
    },
  };
  Object.defineProperty(document, "defaultView", { configurable: true, value: window });

  const globals = [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "fetch",
  ] as const;
  const previous = new Map<PropertyKey, PropertyDescriptor | undefined>(
    globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const elementConstructor = Object.getPrototypeOf(document.documentElement).constructor;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: document },
    navigator: { configurable: true, value: { userAgent: "slash-performance-test" } },
    Node: { configurable: true, value: elementConstructor },
    Element: { configurable: true, value: elementConstructor },
    HTMLElement: { configurable: true, value: elementConstructor },
    requestAnimationFrame: { configurable: true, value: window.requestAnimationFrame },
    cancelAnimationFrame: { configurable: true, value: window.cancelAnimationFrame },
    fetch: { configurable: true, value: window.fetch },
  });

  return {
    container,
    restore: () => {
      assert.deepEqual(sideEffects, { ipc: 0, mcp: 0, network: 0 });
      for (const key of globals) {
        const descriptor = previous.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("opening and rendering the maximum slash catalog stays within the release latency budget", async (t) => {
  const mounted = installMountedDom();
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(mounted.container);
  const catalog = fullCatalog();
  assert.equal(parseSkillCatalog(catalog).length, SLASH_LIMITS.catalogEntries);
  const queries = [
    "",
    "s",
    "skill",
    "skill249",
    "workspace",
    "guidance",
    "\uFDFA".repeat(SLASH_LIMITS.queryCharacters),
    "zzz",
  ];
  const samples: number[] = [];

  try {
    let mountKey = 0;
    const renderQuery = (query: string) => {
      const draft = `$${query}`;
      const session = deriveSlashSession({
        draft,
        selectionStart: draft.length,
        selectionEnd: draft.length,
        composing: false,
        tracker: updateSlashSessionTracker(undefined, draft),
      });
      assert.ok(session);
      assert.equal(session.kind, "skill");
      const ranked = rankSlashResults(session.query, catalog, session.kind);
      assert.ok(ranked.results.length <= SLASH_LIMITS.visibleResults);
      mountKey += 1;
      flushSync(() => {
        const palette = React.createElement(ComposerSlashPalette, {
          mode: session.kind,
          results: ranked.results,
          activeId: ranked.results[0]?.id,
          skillsLoading: false,
          skillsError: false,
          truncated: ranked.truncated,
          commandAvailability: () => ({ available: true }),
          onActiveIdChange: () => undefined,
          onSelect: () => undefined,
          onRetrySkills: () => undefined,
          skillSelectionEnabled: true,
        });
        root.render(
          React.createElement(ComposerSlashPalettePresence, {
            present: true,
            immediate: true,
            key: mountKey,
            children: palette,
          }),
        );
      });
      return ranked;
    };

    // Warm JIT, locale, React, and icon rendering before measuring commits.
    assert.equal(renderQuery("").results.length, SLASH_LIMITS.visibleResults);
    for (let iteration = 0; iteration < 70; iteration += 1) {
      const startedAt = performance.now();
      renderQuery(queries[iteration % queries.length]);
      samples.push(performance.now() - startedAt);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    flushSync(() => root.unmount());
    await new Promise<void>((resolve) => setImmediate(resolve));
    mounted.restore();
  }

  samples.sort((left, right) => left - right);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const maximum = samples[samples.length - 1];
  t.diagnostic(
    `maximum catalog rank/React-commit p95=${p95.toFixed(2)}ms max=${maximum.toFixed(2)}ms`,
  );
  assert.ok(p95 < 100, `slash palette p95 ${p95.toFixed(2)}ms exceeded the 100ms budget`);
});

test("palette opening and rendering consume cached data without side-effect imports", () => {
  const composer = readFileSync(new URL("../components/composer.tsx", import.meta.url), "utf8");
  const palette = readFileSync(
    new URL("../components/composer-slash-palette.tsx", import.meta.url),
    "utf8",
  );
  const openingPipeline = composer.slice(
    composer.indexOf("const slashSession = React.useMemo"),
    composer.indexOf("const slashActionContext = React.useMemo"),
  );

  assert.match(composer, /const skillCatalog = useDiscoveredSkills\(workspace\?\.id\)/u);
  assert.match(openingPipeline, /deriveSlashSession/u);
  assert.match(openingPipeline, /rankSlashResults/u);
  assert.doesNotMatch(openingPipeline, /refetch|invalidateQueries|skillsApi|mcpApi|fetch\(/u);
  assert.doesNotMatch(palette, /\.\.\/lib\/(?:ipc|queries)|useQuery|skillsApi|mcpApi|fetch\(/u);
});
