import type * as React from "react";
import type { BotAvatarColor } from "../../shared/bots";
import type { KeyboardPlatform } from "../../shared/keybindings";
import type { ArtProps } from "./art-kit";
import {
  BrowserArt,
  ComputerUseArt,
  FilesEditorArt,
  GitWorkflowsArt,
  NativeSubagentsArt,
  ReviewDiffsArt,
  TerminalArt,
  WorkspaceAgentArt,
  WorkspacesArt,
} from "./create-art";
import {
  AttachmentsVisionArt,
  McpConnectorsArt,
  ModelFreedomArt,
  ModelPadArt,
  ReusableSkillsArt,
  ThinkingControlsArt,
  ToolScriptsArt,
  WebSearchArt,
} from "./extend-art";
import {
  AidenLiveArt,
  AidenOnTheGoArt,
  BotsArt,
  CommandPaletteArt,
  PermissionsArt,
  ScheduledAutomationsArt,
  TelegramArt,
  ThemesArt,
  UsageProfileArt,
  VoiceDictationArt,
} from "./control-art";

export type FeatureArtSize = "hero" | "tall" | "standard" | "wide";

interface FeatureArtEntry {
  /** The Bot avatar colour mixed into this tile's surfaces. */
  tint: BotAvatarColor;
  Art: (props: ArtProps) => React.JSX.Element;
}

/**
 * One code-drawn illustration per feature-tour tile. Tints alternate so
 * neighbouring tiles in the bento never share a colour.
 */
export const FEATURE_ART = {
  workspace: { tint: "lilac", Art: WorkspaceAgentArt },
  computerUse: { tint: "sky", Art: ComputerUseArt },
  subagents: { tint: "mint", Art: NativeSubagentsArt },
  browser: { tint: "peach", Art: BrowserArt },
  filesEditor: { tint: "sun", Art: FilesEditorArt },
  reviewDiffs: { tint: "aqua", Art: ReviewDiffsArt },
  terminal: { tint: "periwinkle", Art: TerminalArt },
  gitWorkflows: { tint: "coral", Art: GitWorkflowsArt },
  workspaces: { tint: "plum", Art: WorkspacesArt },
  models: { tint: "periwinkle", Art: ModelFreedomArt },
  toolScripts: { tint: "lime", Art: ToolScriptsArt },
  modelPad: { tint: "sky", Art: ModelPadArt },
  thinking: { tint: "sun", Art: ThinkingControlsArt },
  vision: { tint: "rose", Art: AttachmentsVisionArt },
  webSearch: { tint: "aqua", Art: WebSearchArt },
  skills: { tint: "plum", Art: ReusableSkillsArt },
  mcp: { tint: "mint", Art: McpConnectorsArt },
  geminiLive: { tint: "lilac", Art: AidenLiveArt },
  bots: { tint: "peach", Art: BotsArt },
  schedules: { tint: "mint", Art: ScheduledAutomationsArt },
  voice: { tint: "coral", Art: VoiceDictationArt },
  commands: { tint: "periwinkle", Art: CommandPaletteArt },
  telegram: { tint: "sky", Art: TelegramArt },
  aidenOnTheGo: { tint: "lime", Art: AidenOnTheGoArt },
  usage: { tint: "sun", Art: UsageProfileArt },
  permissions: { tint: "aqua", Art: PermissionsArt },
  themes: { tint: "rose", Art: ThemesArt },
} as const satisfies Record<string, FeatureArtEntry>;

export type FeatureArtId = keyof typeof FEATURE_ART;

/** Sets the tile's tint; the art and the tile background both read it. */
export function featureArtTintStyle(id: FeatureArtId): React.CSSProperties {
  return { "--oa-tint": `var(--bot-avatar-${FEATURE_ART[id].tint})` } as React.CSSProperties;
}

export function FeatureArt({
  id,
  size,
  platform,
}: {
  id: FeatureArtId;
  size: FeatureArtSize;
  platform: KeyboardPlatform;
}) {
  const { Art } = FEATURE_ART[id];
  return (
    <div aria-hidden="true" className="oa-art" data-onboarding-art={id} data-size={size}>
      <Art platform={platform} />
    </div>
  );
}
