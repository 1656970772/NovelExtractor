import type { ProviderPreset } from "@novel-extractor/config";
import {
  createPresetProviderDefinition,
  type OpenAiCompatibleProviderDefinition
} from "./providerRegistry";

export function createDeepSeekProviderDefinition(
  preset: ProviderPreset
): OpenAiCompatibleProviderDefinition {
  if (preset.id !== "deepseek") {
    throw new Error(`Expected DeepSeek provider preset, received ${preset.id}`);
  }

  return createPresetProviderDefinition(preset);
}
