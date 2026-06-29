import type { ProviderKind, ProviderPresetId } from "@novel-extractor/config";

export type { ProviderKind, ProviderPresetId };

export interface ApiKeyRef {
  id: string;
  providerConfigId: string;
}

export interface ProviderModelConfig {
  id: string;
  displayName: string;
  enabled: boolean;
  isDefault: boolean;
}

export interface ProviderConfig {
  id: string;
  presetId: ProviderPresetId;
  displayName: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKeyRef?: ApiKeyRef;
  models: ProviderModelConfig[];
  enabled: boolean;
}
