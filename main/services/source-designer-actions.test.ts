import assert from "node:assert/strict";
import test from "node:test";
import * as ts from "typescript";

test("TypeScript identifies the smallest exact JSX element at a source position", () => {
  const source = `export function App() {\n  return <button><span>Save</span></button>;\n}\n`;
  const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
