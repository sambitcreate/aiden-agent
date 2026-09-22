export interface CreateImagesFixtureSummary {
  id: string;
  title: string;
  description: string;
  nodeCount: number;
  updatedLabel: string;
}

export const CREATE_IMAGES_FIXTURES: readonly CreateImagesFixtureSummary[] = Object.freeze([
  Object.freeze({
    id: "starter",
    title: "Editorial portrait study",
    description: "Prompt → Generate Image → Output",
    nodeCount: 3,
    updatedLabel: "Starter",
  }),
  Object.freeze({
    id: "reference-edit",
    title: "Reference-led campaign",
    description: "Image + prompt → Generate Image → Gallery",
    nodeCount: 4,
    updatedLabel: "Fixture",
  }),
  Object.freeze({
    id: "stress-100",
    title: "100-node canvas fixture",
    description: "Mixed-node performance and keyboard test",
    nodeCount: 100,
    updatedLabel: "Performance",
  }),
]);
