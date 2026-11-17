// Aiden Live preferences shared by Settings, the floating ribbon and main's
// settings parser. Every field is optional in AppSettings; an omitted field
// means the default listed here.

/** Gemini Live's prebuilt voices, with Google's one-word character for each. */
export const AIDEN_LIVE_VOICES: ReadonlyArray<{ id: string; character: string }> = [
  { id: "Puck", character: "Upbeat" },
  { id: "Kore", character: "Firm" },
  { id: "Charon", character: "Informative" },
  { id: "Aoede", character: "Breezy" },
  { id: "Zephyr", character: "Bright" },
  { id: "Fenrir", character: "Excitable" },
  { id: "Leda", character: "Youthful" },
  { id: "Orus", character: "Firm" },
  { id: "Callirrhoe", character: "Easy-going" },
  { id: "Autonoe", character: "Bright" },
  { id: "Enceladus", character: "Breathy" },
  { id: "Iapetus", character: "Clear" },
  { id: "Umbriel", character: "Easy-going" },
  { id: "Algieba", character: "Smooth" },
  { id: "Despina", character: "Smooth" },
  { id: "Erinome", character: "Clear" },
  { id: "Algenib", character: "Gravelly" },
  { id: "Rasalgethi", character: "Informative" },
  { id: "Laomedeia", character: "Upbeat" },
  { id: "Achernar", character: "Soft" },
  { id: "Alnilam", character: "Firm" },
  { id: "Schedar", character: "Even" },
  { id: "Gacrux", character: "Mature" },
  { id: "Pulcherrima", character: "Forward" },
  { id: "Achird", character: "Friendly" },
  { id: "Zubenelgenubi", character: "Casual" },
  { id: "Vindemiatrix", character: "Gentle" },
  { id: "Sadachbia", character: "Lively" },
  { id: "Sadaltager", character: "Knowledgeable" },
  { id: "Sulafat", character: "Warm" },
];

/** Live's voice when the user has not picked one. */
export const AIDEN_LIVE_DEFAULT_VOICE = "Puck";

/** Playback speeds offered in the ribbon menu; pitch stays the same. */
export const AIDEN_LIVE_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
export type AidenLiveSpeed = (typeof AIDEN_LIVE_SPEEDS)[number];

export type AidenLiveRibbonColors = "spectrum" | "accent";

export interface AidenLivePreferences {
  voice: string;
  speed: AidenLiveSpeed;
  ribbonColors: AidenLiveRibbonColors;
  /** Live may read, send to, stop, find and start chats. */
  chatAccess: boolean;
  /** The one-time notice about chat access was shown. */
  chatAccessNoticeShown: boolean;
  /** Approvals in the open chat can be answered by voice. */
  voiceApprovals: boolean;
  /** Live may look at and press controls in Aiden's own window. */
  appControl: boolean;
}

/** The AppSettings fields these preferences live in. */
export interface AidenLiveSettingsFields {
  aidenLiveVoice?: string;
  aidenLiveSpeed?: number;
  aidenLiveRibbonColors?: AidenLiveRibbonColors;
  aidenLiveChatAccess?: boolean;
  aidenLiveChatAccessNoticeShown?: boolean;
  aidenLiveVoiceApprovals?: boolean;
  aidenLiveAppControl?: boolean;
}

export function isAidenLiveVoice(value: unknown): value is string {
  return typeof value === "string" && AIDEN_LIVE_VOICES.some((voice) => voice.id === value);
}

export function isAidenLiveSpeed(value: unknown): value is AidenLiveSpeed {
  return typeof value === "number" && (AIDEN_LIVE_SPEEDS as readonly number[]).includes(value);
}

export function isAidenLiveRibbonColors(value: unknown): value is AidenLiveRibbonColors {
  return value === "spectrum" || value === "accent";
}

/** Reads stored settings into preferences, falling back field by field. */
export function aidenLivePreferences(settings: AidenLiveSettingsFields | null | undefined): AidenLivePreferences {
  return {
    voice: isAidenLiveVoice(settings?.aidenLiveVoice) ? settings.aidenLiveVoice : AIDEN_LIVE_DEFAULT_VOICE,
    speed: isAidenLiveSpeed(settings?.aidenLiveSpeed) ? settings.aidenLiveSpeed : 1,
    ribbonColors: isAidenLiveRibbonColors(settings?.aidenLiveRibbonColors)
      ? settings.aidenLiveRibbonColors
      : "spectrum",
    chatAccess: settings?.aidenLiveChatAccess !== false,
    chatAccessNoticeShown: settings?.aidenLiveChatAccessNoticeShown === true,
    voiceApprovals: settings?.aidenLiveVoiceApprovals !== false,
    appControl: settings?.aidenLiveAppControl !== false,
  };
}

const BOOLEAN_KEYS = [
  "aidenLiveChatAccess",
  "aidenLiveChatAccessNoticeShown",
  "aidenLiveVoiceApprovals",
  "aidenLiveAppControl",
] as const;

/**
 * Validates a settings patch's Live fields. Returns only the fields present;
 * throws on a wrong type or an unknown voice, speed or colour choice.
 */
export function parseAidenLiveSettingsPatch(patch: Record<string, unknown>): AidenLiveSettingsFields {
  const next: AidenLiveSettingsFields = {};
  if (patch.aidenLiveVoice !== undefined) {
    if (!isAidenLiveVoice(patch.aidenLiveVoice)) throw new Error("Invalid Aiden Live voice.");
    next.aidenLiveVoice = patch.aidenLiveVoice;
  }
  if (patch.aidenLiveSpeed !== undefined) {
    if (!isAidenLiveSpeed(patch.aidenLiveSpeed)) throw new Error("Invalid Aiden Live speed.");
    next.aidenLiveSpeed = patch.aidenLiveSpeed;
  }
  if (patch.aidenLiveRibbonColors !== undefined) {
    if (!isAidenLiveRibbonColors(patch.aidenLiveRibbonColors)) {
      throw new Error("Invalid Aiden Live ribbon colours.");
    }
    next.aidenLiveRibbonColors = patch.aidenLiveRibbonColors;
  }
  for (const key of BOOLEAN_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new Error("Invalid Aiden Live setting.");
    next[key] = value;
  }
  return next;
}
