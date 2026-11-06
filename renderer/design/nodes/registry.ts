import type { NodeTypes } from "@xyflow/react";
import { ArtboardNode } from "./artboard-node";
import { ArtifactNode } from "./artifact-node";
import { ConnectorNode } from "./connector-node";
import { FileNode } from "./file-node";
import { GroupNode } from "./group-node";
import { ImageNode } from "./image-node";
import { NoteNode } from "./note-node";
import { ShapeNode } from "./shape-node";
import { StrokeNode } from "./stroke-node";
import { TextNode } from "./text-node";

/** One React Flow node type per design frame kind. Defined once, so React Flow never remounts nodes. */
export const designNodeTypes: NodeTypes = {
  file: FileNode,
  artifact: ArtifactNode,
  image: ImageNode,
  note: NoteNode,
  group: GroupNode,
  text: TextNode,
  shape: ShapeNode,
  connector: ConnectorNode,
  stroke: StrokeNode,
  frame: ArtboardNode,
};
