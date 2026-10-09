// Curated on-device speech catalog. Every archive is a k2-fsa sherpa-onnx
// release asset pinned by exact byte size and SHA-256; nothing here is
// fetched at runtime. Scores are relative display hints from Handy's
// catalog.json at f6b3f82 (score / 100).

export const SPEECH_MODEL_RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

export type SpeechModelFamily = "nemo-transducer" | "nemo-canary" | "whisper" | "sense-voice" | "moonshine-v2";

export interface SpeechModelSpec {
  id: string;
  name: string;
  description: string;
  family: SpeechModelFamily;
  archive: { url: string; bytes: number; sha256: string };
  /** Role → relative path inside the installed directory. */
  files: Readonly<Record<string, string>>;
  languages: readonly string[];
  capabilities: {
    autoDetect: boolean;
    languageHint: boolean;
    translateToEnglish: boolean;
    maxWindowSeconds: number | null;
  };
  accuracy: number;
  speed: number;
  recommended: boolean;
  license: { name: string; url: string; attribution?: string };
}

const PARAKEET_V3_LANGUAGES = [
  "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it",
  "lv", "lt", "mt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv", "uk",
] as const;

// Whisper's 99 languages, in Whisper's own order.
const WHISPER_LANGUAGES = [
  "en","zh","de","es","ru","ko","fr","ja","pt","tr","pl","ca","nl","ar","sv","it","id","hi","fi","vi",
  "he","uk","el","ms","cs","ro","da","hu","ta","no","th","ur","hr","bg","lt","la","mi","ml","cy","sk",
  "te","fa","lv","bn","sr","az","sl","kn","et","mk","br","eu","is","hy","ne","mn","bs","kk","sq","sw",
  "gl","mr","pa","si","km","sn","yo","so","af","oc","ka","be","tg","sd","gu","am","yi","lo","uz","fo",
  "ht","ps","tk","nn","mt","sa","lb","my","bo","tl","mg","as","tt","haw","ln","ha","ba","jw","su",
] as const;

const NVIDIA_CC_BY = { name: "CC-BY-4.0 (NVIDIA)", url: "https://creativecommons.org/licenses/by/4.0/" };
const TRANSDUCER_FILES = {
  encoder: "encoder.int8.onnx",
  decoder: "decoder.int8.onnx",
  joiner: "joiner.int8.onnx",
  tokens: "tokens.txt",
} as const;

export const SPEECH_MODELS: readonly SpeechModelSpec[] = Object.freeze<SpeechModelSpec[]>([
  {
    id: "parakeet-v3",
    name: "Parakeet TDT 0.6B v3",
    description: "Fast and accurate across 25 European languages.",
    family: "nemo-transducer",
    archive: { url: `${SPEECH_MODEL_RELEASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`, bytes: 487_170_055, sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf" },
    files: TRANSDUCER_FILES,
    languages: PARAKEET_V3_LANGUAGES,
    capabilities: { autoDetect: true, languageHint: false, translateToEnglish: false, maxWindowSeconds: null },
    accuracy: 0.88, speed: 0.79, recommended: true, license: NVIDIA_CC_BY,
  },
  {
    id: "parakeet-v2",
    name: "Parakeet TDT 0.6B v2",
    description: "English only, and the most accurate model for English.",
    family: "nemo-transducer",
    archive: { url: `${SPEECH_MODEL_RELEASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`, bytes: 482_468_385, sha256: "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad" },
    files: TRANSDUCER_FILES,
    languages: ["en"],
    capabilities: { autoDetect: false, languageHint: false, translateToEnglish: false, maxWindowSeconds: null },
    accuracy: 0.89, speed: 0.85, recommended: false, license: NVIDIA_CC_BY,
  },
  {
    id: "canary-180m-flash",
    name: "Canary 180M Flash",
    description: "Small and very fast. English, German, Spanish and French, with translation to English.",
    family: "nemo-canary",
    archive: { url: `${SPEECH_MODEL_RELEASE}/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2`, bytes: 153_692_328, sha256: "7a38ed8b13f014ad632b09ff8d22e0c6f1359dd046af9235d281dfae841b9ab9" },
    files: { encoder: "encoder.int8.onnx", decoder: "decoder.int8.onnx", tokens: "tokens.txt" },
    languages: ["en", "de", "es", "fr"],
    capabilities: { autoDetect: false, languageHint: true, translateToEnglish: true, maxWindowSeconds: null },
    accuracy: 0.88, speed: 0.98, recommended: false, license: NVIDIA_CC_BY,
  },
  {
    id: "whisper-turbo",
    name: "Whisper Large v3 Turbo",
    description: "Broadest language coverage. Slower than the others.",
    family: "whisper",
    archive: { url: `${SPEECH_MODEL_RELEASE}/sherpa-onnx-whisper-turbo.tar.bz2`, bytes: 563_790_207, sha256: "b11acbbcd660b44a8e0df33724feb5aaa709cf65668f2823d59f656312544f22" },
    files: { encoder: "turbo-encoder.int8.onnx", decoder: "turbo-decoder.int8.onnx", tokens: "turbo-tokens.txt" },
    languages: WHISPER_LANGUAGES,
    capabilities: { autoDetect: true, languageHint: true, translateToEnglish: false, maxWindowSeconds: 30 },
    accuracy: 0.88, speed: 0.35, recommended: false, license: { name: "MIT (OpenAI Whisper)", url: "https://github.com/openai/whisper/blob/main/LICENSE" },
  },
  {
    id: "sense-voice",
    name: "SenseVoice Small",
    description: "Fast Chinese, Cantonese, English, Japanese and Korean.",
    family: "sense-voice",
    archive: { url: `${SPEECH_MODEL_RELEASE}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`, bytes: 163_002_883, sha256: "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e" },
    files: { model: "model.int8.onnx", tokens: "tokens.txt" },
    languages: ["zh", "yue", "en", "ja", "ko"],
    capabilities: { autoDetect: true, languageHint: true, translateToEnglish: false, maxWindowSeconds: 30 },
    accuracy: 0.81, speed: 0.98, recommended: false,
    license: { name: "FunASR Model License 1.1", url: "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE", attribution: "SenseVoice Small, Alibaba FunAudioLLM" },
  },
  {
    id: "moonshine-base-en",
    name: "Moonshine Base",
    description: "Tiny English model for Macs with little free memory.",
    family: "moonshine-v2",
    archive: { url: `${SPEECH_MODEL_RELEASE}/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`, bytes: 111_266_225, sha256: "43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891" },
    files: { encoder: "encoder_model.ort", mergedDecoder: "decoder_model_merged.ort", tokens: "tokens.txt" },
    languages: ["en"],
    capabilities: { autoDetect: false, languageHint: false, translateToEnglish: false, maxWindowSeconds: 30 },
    accuracy: 0.8, speed: 0.99, recommended: false, license: { name: "MIT (Moonshine English models)", url: "https://github.com/moonshine-ai/moonshine/blob/main/LICENSE" },
  },
]);

export const SILERO_VAD = Object.freeze({
  file: "silero_vad.onnx",
  bytes: 643_854,
  sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
});

export function speechModel(id: string): SpeechModelSpec | undefined {
  return SPEECH_MODELS.find((model) => model.id === id);
}

export function formatSizeLabel(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", zh: "Chinese", yue: "Cantonese", ja: "Japanese", ko: "Korean",
  de: "German", es: "Spanish", fr: "French",
};

export function languagesLabel(spec: Pick<SpeechModelSpec, "languages">): string {
  if (spec.languages.length > 5) return `${spec.languages.length} languages`;
  return spec.languages.map((code) => LANGUAGE_NAMES[code] ?? code).join(", ");
}
