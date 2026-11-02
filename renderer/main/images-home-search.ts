/** The Images home's view; `/images?view=images` opens All Images, so Back from a workflow returns to it. */
export type ImagesHomeView = "workflows" | "images";

export function parseImagesHomeSearch(search: Record<string, unknown>): { view?: "images" } {
  return search.view === "images" ? { view: "images" } : {};
}
