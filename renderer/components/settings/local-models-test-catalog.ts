// Test fixture: the real pinned speech catalog shaped like `localModels:list`.
import {
  formatSizeLabel,
  languagesLabel,
  SPEECH_MODELS,
} from "../../../main/services/local-speech-catalog";
import type { LocalVoiceModel } from "../../lib/types";

export function localModelsTestCatalog(installed: readonly string[] = []): LocalVoiceModel[] {
  return SPEECH_MODELS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    sizeLabel: formatSizeLabel(spec.archive.bytes),
    quant: "int8",
    languagesLabel: languagesLabel(spec),
    accuracy: spec.accuracy,
    speed: spec.speed,
    recommended: spec.recommended,
    installed: installed.includes(spec.id),
    languages: [...spec.languages],
    capabilities: { ...spec.capabilities },
    license: { ...spec.license },
  }));
}
