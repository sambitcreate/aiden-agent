// Test fixture: the real pinned speech catalog shaped like `localModels:list`.
// By default it is the catalog of a host without Apple silicon; pass
// `appleSilicon` for the catalog that adds Parakeet on Metal.
import {
  formatSizeLabel,
  languagesLabel,
  PORTABLE_SPEECH_MODELS,
  recommendedSpeechModelId,
  speechModelsForHost,
} from "../../../main/services/local-speech-catalog";
import type { LocalVoiceModel } from "../../lib/types";

export function localModelsTestCatalog(
  installed: readonly string[] = [],
  options: { appleSilicon?: boolean } = {},
): LocalVoiceModel[] {
  const specs = options.appleSilicon ? speechModelsForHost({ platform: "darwin", arch: "arm64" }) : PORTABLE_SPEECH_MODELS;
  const recommended = recommendedSpeechModelId(specs);
  return specs.map((spec) => ({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    sizeLabel: formatSizeLabel(spec.archive.bytes),
    quant: spec.quant ?? "int8",
    languagesLabel: languagesLabel(spec),
    accuracy: spec.accuracy,
    speed: spec.speed,
    recommended: spec.id === recommended,
    installed: installed.includes(spec.id),
    languages: [...spec.languages],
    capabilities: { ...spec.capabilities },
    license: { ...spec.license },
  }));
}
