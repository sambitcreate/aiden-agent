import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as ts from "typescript";
import {
  SourceDesignerActionService,
  type ResolvedSourceSelection,
} from "./source-designer-actions.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import { sourceDesignerMultifileSha256 } from "./source-designer-multifile-contract.js";
import {
  createSourceDesignerMultifileCoordinator,
  type SourceDesignerMultifileFilePort,
} from "./source-designer-multifile-coordinator.js";
import { SourceDesignerMultifileJournalStore } from "./source-designer-multifile-journal.js";

test("TypeScript identifies the smallest exact JSX element at a source position", () => {
  const source = `export function App() {\n  return <button><span>Save</span></button>;\n}\n`;
  const file = ts.createSourceFile(
    "App.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const position = file.getPositionOfLineAndCharacter(1, 19);
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (position >= node.getFullStart() && position <= node.getEnd()) {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) matches.push(node);
      ts.forEachChild(node, visit);
    }
  };
  visit(file);
  matches.sort((left, right) => left.getWidth(file) - right.getWidth(file));
  assert.equal(matches[0]?.getText(file), "<span>Save</span>");
});

test("project cascade inspection and deletion are chat-scoped, idempotent, and fail closed", () => {
  const service = new SourceDesignerActionService();
  const owner: ChatGenerationOwner = {
    id: 1,
    documentId: "document:one",
    isDestroyed: () => false,
    send: () => undefined,
    onInvalidated: () => () => undefined,
  };
  const source = "<button>Save</button>";
  const binding: ResolvedSourceSelection = {
    version: 1,
    id: "selection:one",
    projectId: "project:one",
    sessionId: "session:one",
    workspaceId: "workspace:one",
    path: "src/App.tsx",
    sourceVersion: "a".repeat(64),
    start: 0,
    end: source.length,
    lineNumber: 1,
    columnNumber: 1,
    snippet: source,
    selection: {
      version: 1,
      selector: '[data-aiden-id="save"]',
      tagName: "button",
      label: "Save",
    },
    ownerDocumentId: owner.documentId,
    root: "/tmp/workspace",
    source,
    createdAt: Date.now(),
  };
  const first = service.propose({
    owner,
    chatId: "chat:one",
    binding,
    label: "Update Save",
    replacement: "<button>Saved</button>",
  });
  const other = service.propose({
    owner,
    chatId: "chat:two",
    binding,
    label: "Update Other",
    replacement: "<button>Other</button>",
  });
  assert.equal(first.projectId, "project:one");
  assert.deepEqual(service.list(owner, "project:one", "chat:one", "workspace:one"), [first]);
  assert.deepEqual(service.list(owner, "project:two", "chat:one", "workspace:one"), []);
  assert.deepEqual(service.inspectChatActionIds("chat:one"), [first.id]);
  assert.equal(service.deleteChatActions("chat:one", [first.id]), 1);
  assert.equal(service.deleteChatActions("chat:one", [first.id]), 0);
  assert.deepEqual(service.inspectChatActionIds("chat:two"), [other.id]);

  const later = service.propose({
    owner,
    chatId: "chat:one",
    binding,
    label: "Later",
    replacement: "<button>Later</button>",
  });
  assert.throws(() => service.deleteChatActions("chat:one", [first.id]), /changed after deletion/u);
  assert.deepEqual(service.inspectChatActionIds("chat:one"), [later.id]);
});

test("durable connected proof rejects a cross-file second component use after review", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-source-proof-"));
  try {
    await mkdir(join(root, "src"));
    const panel = `export function Panel() {\n  return <button id="save">Save</button>;\n}\n`;
    await writeFile(join(root, "src", "Panel.tsx"), panel, "utf8");
    await writeFile(
      join(root, "src", "App.tsx"),
      `export default function App() { return <Panel />; }\n`,
      "utf8",
    );
    const app = `export default function App() { return <Panel />; }\n`;
    const snippet = `<button id="save">Save</button>`;
    const start = panel.indexOf(snippet);
    const binding: ResolvedSourceSelection = {
      version: 1,
      id: "selection:proof",
      projectId: "project:proof",
      sessionId: "session:proof",
      workspaceId: "workspace:proof",
      path: "src/Panel.tsx",
      sourceVersion: createHash("sha256").update(panel).digest("hex"),
      start,
      end: start + snippet.length,
      lineNumber: 2,
      columnNumber: 10,
      snippet,
      selection: {
        version: 1,
        selector: "#save",
        tagName: "button",
        label: "Save",
        elementId: "save",
      },
      ownerDocumentId: "document:proof",
      root,
      source: panel,
      createdAt: Date.now(),
      componentName: "Panel",
      selectorMatchCount: 1,
    };
    const service = new SourceDesignerActionService();
    assert.equal(await service.proveConnectedComponentSingleUse(binding), true);
    const manifestHash = await service.connectedComponentManifestHash(binding);
    assert.match(manifestHash ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(
      await service.proveDurableConnectedComponentSingleUse({
        selectionId: binding.id,
        workspaceId: binding.workspaceId,
        root,
        path: binding.path,
        sourceVersion: binding.sourceVersion,
        source: panel,
        start: binding.start,
        end: binding.end,
        lineNumber: binding.lineNumber,
        columnNumber: binding.columnNumber,
        componentName: binding.componentName!,
        selector: binding.selection.selector,
        tagName: binding.selection.tagName,
        elementId: binding.selection.elementId,
        manifestHash: manifestHash!,
      }),
      true,
    );

    const postSource = panel.replace(">Save</button>", ">Saved</button>");
    const postProof = await service.connectedComponentPostimageProof(binding, postSource);
    assert.ok(postProof);
    const rootFingerprint = "a".repeat(64);
    const files: SourceDesignerMultifileFilePort = {
      async inspect(input) {
        const bytes = await readFile(join(root, input.path));
        return {
          path: input.path,
          noFollow: true,
          contained: true,
          kind: "regular-file",
          bytes,
          byteSize: bytes.byteLength,
          sha256: sourceDesignerMultifileSha256(bytes),
          rootFingerprint,
        };
      },
      async write(input) {
        const current = await this.inspect(input);
        assert.equal(current.sha256, input.expectedSha256);
        await writeFile(join(root, input.path), input.bytes);
        return this.inspect(input);
      },
    };
    const journalRoot = join(root, "journal");
    await mkdir(journalRoot);
    const coordinator = createSourceDesignerMultifileCoordinator({
      journal: new SourceDesignerMultifileJournalStore(() => journalRoot),
      files,
    });
    const prove = (
      source: string,
      proof: {
        manifestHash: string;
        sourceVersion: string;
        start: number;
        end: number;
        lineNumber: number;
        columnNumber: number;
      },
    ) =>
      service.proveDurableConnectedComponentSingleUse({
        selectionId: binding.id,
        workspaceId: binding.workspaceId,
        root,
        path: binding.path,
        source,
        ...proof,
        componentName: binding.componentName!,
        selector: binding.selection.selector,
        tagName: binding.selection.tagName,
        ...(binding.selection.elementId ? { elementId: binding.selection.elementId } : {}),
      });
    const prepared = await coordinator.prepare({
      actionId: "action:valid-post-proof",
      workspaceId: binding.workspaceId,
      label: "Change label",
      files: [
        {
          path: binding.path,
          expectedBeforeSha256: binding.sourceVersion,
          afterBytes: Buffer.from(postSource),
        },
      ],
    });
    assert.equal(
      (
        await coordinator.apply(prepared.actionId, {
          before: () =>
            prove(panel, {
              manifestHash: manifestHash!,
              sourceVersion: binding.sourceVersion,
              start: binding.start,
              end: binding.end,
              lineNumber: binding.lineNumber,
              columnNumber: binding.columnNumber,
            }),
          after: () => prove(postSource, postProof),
        })
      ).status,
      "committed",
    );
    assert.match(await readFile(join(root, binding.path), "utf8"), />Saved<\/button>/u);
    assert.equal((await coordinator.undo(prepared.actionId)).status, "undone");

    const postApp = `export default function App() { return <main><Panel /></main>; }\n`;
    const multifilePostProof = await service.connectedComponentPostimageProof(
      binding,
      postSource,
      new Map([["src/App.tsx", postApp]]),
    );
    assert.ok(multifilePostProof);
    const multifile = await coordinator.prepare({
      actionId: "action:valid-multifile-post-proof",
      workspaceId: binding.workspaceId,
      label: "Change the panel and its app shell",
      files: [
        {
          path: binding.path,
          expectedBeforeSha256: binding.sourceVersion,
          afterBytes: Buffer.from(postSource),
        },
        {
          path: "src/App.tsx",
          expectedBeforeSha256: sourceDesignerMultifileSha256(Buffer.from(app)),
          afterBytes: Buffer.from(postApp),
        },
      ],
    });
    assert.equal(
      (
        await coordinator.apply(multifile.actionId, {
          before: () =>
            prove(panel, {
              manifestHash: manifestHash!,
              sourceVersion: binding.sourceVersion,
              start: binding.start,
              end: binding.end,
              lineNumber: binding.lineNumber,
              columnNumber: binding.columnNumber,
            }),
          after: () => prove(postSource, multifilePostProof),
        })
      ).status,
      "committed",
    );
    assert.equal(await readFile(join(root, "src", "App.tsx"), "utf8"), postApp);
    assert.equal((await coordinator.undo(multifile.actionId)).status, "undone");
    assert.equal(await readFile(join(root, binding.path), "utf8"), panel);
    assert.equal(await readFile(join(root, "src", "App.tsx"), "utf8"), app);

    assert.equal(
      await service.connectedComponentPostimageProof(
        binding,
        postSource,
        new Map([
          ["src/App.tsx", `export default function App() { return <><Panel /><Panel /></>; }\n`],
        ]),
      ),
      undefined,
    );

    const drift = await coordinator.prepare({
      actionId: "action:post-proof-drift",
      workspaceId: binding.workspaceId,
      label: "Change label with drift",
      files: [
        {
          path: binding.path,
          expectedBeforeSha256: binding.sourceVersion,
          afterBytes: Buffer.from(postSource),
        },
      ],
    });
    assert.equal(
      (
        await coordinator.apply(drift.actionId, {
          before: () =>
            prove(panel, {
              manifestHash: manifestHash!,
              sourceVersion: binding.sourceVersion,
              start: binding.start,
              end: binding.end,
              lineNumber: binding.lineNumber,
              columnNumber: binding.columnNumber,
            }),
          after: async () => {
            await writeFile(
              join(root, "src", "App.tsx"),
              `export default function App() { return <><Panel /><Panel /></>; }\n`,
              "utf8",
            );
            return prove(postSource, postProof);
          },
        })
      ).status,
      "rolled-back",
    );
    assert.equal(await readFile(join(root, binding.path), "utf8"), panel);

    assert.equal(await service.proveConnectedComponentSingleUse(binding), false);
    assert.equal(
      await service.proveDurableConnectedComponentSingleUse({
        selectionId: binding.id,
        workspaceId: binding.workspaceId,
        root,
        path: binding.path,
        sourceVersion: binding.sourceVersion,
        source: panel,
        start: binding.start,
        end: binding.end,
        lineNumber: binding.lineNumber,
        columnNumber: binding.columnNumber,
        componentName: binding.componentName!,
        selector: binding.selection.selector,
        tagName: binding.selection.tagName,
        elementId: binding.selection.elementId,
        manifestHash: manifestHash!,
      }),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
