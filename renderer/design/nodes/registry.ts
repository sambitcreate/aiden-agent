import type { NodeTypes } from "@xyflow/react";
import { ArtifactNode } from "./artifact-node";
import { FileNode } from "./file-node";
import { GroupNode } from "./group-node";
import { ImageNode } from "./image-node";
import { NoteNode } from "./note-node";

/** One React Flow node type per design frame kind. Defined once, so React Flow never remounts nodes. */
export const designNodeTypes: NodeTypes = {
  file: FileNode,
  artifact: ArtifactNode,
  image: ImageNode,
  note: NoteNode,
  group: GroupNode,
};
