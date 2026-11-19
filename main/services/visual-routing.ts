// One rule for where a visual goes, shared by the visuals prompt, the design
// mode prompt and the artifacts and design skills, so they never disagree:
// an answer in the reply is an inline visual, a page to keep is a workspace
// artifact, screens to iterate on go on the design canvas, and pictures come
// from the image tools.

/** Which destinations the turn has tools for. */
export type VisualDestinations = {
  /** render_ui or render_artifact. */
  inline: boolean;
  /** workspace_artifact. */
  workspaceArtifact: boolean;
  /** "on": the canvas tools are here; "offered": design_mode can ask to open it. */
  designCanvas: "on" | "offered" | "off";
  /** generate_image and its siblings. */
  images: boolean;
};

const INLINE = "an answer to this message goes in your reply as an inline visual";
const ARTIFACT =
  "a page the person will come back to (a dashboard they check daily, a status board, a checklist) is a workspace artifact (workspace_artifact)";
/** Only said where design mode is part of the choice, so a turn without it never hears of it. */
const ARTIFACT_IN_DESIGN_MODE = `${ARTIFACT}, even in design mode`;
const CANVAS_ON = "screens, pages and directions to design and iterate on go on the design canvas as design/*.html files";
const CANVAS_OFFERED =
  "screens, pages and directions to design and iterate on go on the design canvas: call design_mode to ask to open it";
const IMAGES = "a picture, photo or illustration comes from the image tools (generate_image), not from HTML";

/**
 * The rule for this turn, naming only destinations it has tools for. Empty
 * when there is nothing to choose between. Stable for a given set of tools,
 * so it keeps the prompt cache.
 */
export function visualRoutingRule(destinations: VisualDestinations): string {
  const parts = [
    destinations.inline ? INLINE : null,
    destinations.workspaceArtifact ? (destinations.designCanvas === "off" ? ARTIFACT : ARTIFACT_IN_DESIGN_MODE) : null,
    destinations.designCanvas === "on" ? CANVAS_ON : destinations.designCanvas === "offered" ? CANVAS_OFFERED : null,
    destinations.images ? IMAGES : null,
  ].filter((part): part is string => part !== null);
  if (parts.length < 2) return "";
  return `Where a visual goes: ${parts.join("; ")}.`;
}

/** The whole rule for a skill, which loads whatever tools the turn has. */
export const VISUAL_ROUTING_SKILL_LINE =
  `Where a visual goes: ${INLINE}; ${ARTIFACT_IN_DESIGN_MODE}; ` +
  "screens, pages and directions to design and iterate on go on the design canvas as design/*.html files (when design mode is off, design_mode asks to open it); " +
  `${IMAGES}. Use only the tools you have.`;
