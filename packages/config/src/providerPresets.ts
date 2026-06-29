import { getDefaultConfig } from "./defaults";
import type { ProviderPreset } from "./schema";

export function getProviderPresets(): ProviderPreset[] {
  return getDefaultConfig().providerPresets;
}
