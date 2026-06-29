import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ApiKeyRef } from "@novel-extractor/domain";
import type { ProviderViewDto } from "../shared/ipcTypes";

export interface SaveApiKeyInput {
  providerConfigId: string;
  apiKey: string;
}

export interface MemoryCredentialStoreOptions {
  idFactory?: () => string;
}

export interface FileCredentialStoreOptions extends MemoryCredentialStoreOptions {
  decodeSecret?: (encodedSecret: string) => string;
  encodeSecret?: (secret: string) => string;
  filePath: string;
}

export interface MemoryCredentialStore {
  saveApiKey(input: SaveApiKeyInput): ApiKeyRef;
  hasApiKey(ref: ApiKeyRef): boolean;
  readApiKey(ref: ApiKeyRef): string | undefined;
}

export interface ProviderViewInput {
  id: string;
  presetId: ProviderViewDto["presetId"];
  displayName: string;
  kind: ProviderViewDto["kind"];
  baseUrl?: string;
  models: ProviderViewDto["models"];
  apiKeyRef?: ApiKeyRef;
  enabled: boolean;
}

export const REDACTED_SECRET = "[REDACTED]";

export function createMemoryCredentialStore(
  options: MemoryCredentialStoreOptions = {}
): MemoryCredentialStore {
  const valuesByRefId = new Map<string, string>();
  const idFactory = options.idFactory ?? randomUUID;

  return {
    saveApiKey(input) {
      const ref = {
        id: idFactory(),
        providerConfigId: input.providerConfigId
      };
      valuesByRefId.set(ref.id, input.apiKey);
      return ref;
    },
    hasApiKey(ref) {
      return valuesByRefId.has(ref.id);
    },
    readApiKey(ref) {
      return valuesByRefId.get(ref.id);
    }
  };
}

interface CredentialStoreState {
  apiKeysByRefId: Record<string, { providerConfigId: string; apiKey: string }>;
}

function createEmptyCredentialState(): CredentialStoreState {
  return { apiKeysByRefId: {} };
}

function loadCredentialState(filePath: string): CredentialStoreState {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CredentialStoreState>;
    return parsed.apiKeysByRefId && typeof parsed.apiKeysByRefId === "object"
      ? { apiKeysByRefId: parsed.apiKeysByRefId }
      : createEmptyCredentialState();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return createEmptyCredentialState();
  }
}

function saveCredentialState(filePath: string, state: CredentialStoreState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function createFileCredentialStore(
  options: FileCredentialStoreOptions
): MemoryCredentialStore {
  const idFactory = options.idFactory ?? randomUUID;
  const state = loadCredentialState(options.filePath);

  return {
    saveApiKey(input) {
      const ref = {
        id: idFactory(),
        providerConfigId: input.providerConfigId
      };
      state.apiKeysByRefId[ref.id] = {
        providerConfigId: input.providerConfigId,
        apiKey: options.encodeSecret ? options.encodeSecret(input.apiKey) : input.apiKey
      };
      saveCredentialState(options.filePath, state);
      return ref;
    },
    hasApiKey(ref) {
      const entry = state.apiKeysByRefId[ref.id];
      return Boolean(entry && entry.providerConfigId === ref.providerConfigId);
    },
    readApiKey(ref) {
      const entry = state.apiKeysByRefId[ref.id];
      if (!entry || entry.providerConfigId !== ref.providerConfigId) {
        return undefined;
      }
      return options.decodeSecret ? options.decodeSecret(entry.apiKey) : entry.apiKey;
    }
  };
}

export function createProviderView(input: ProviderViewInput): ProviderViewDto {
  return {
    id: input.id,
    presetId: input.presetId,
    displayName: input.displayName,
    kind: input.kind,
    baseUrl: input.baseUrl,
    models: input.models.map((model) => ({ ...model })),
    hasApiKey: Boolean(input.apiKeyRef),
    enabled: input.enabled
  };
}

export function redactSecrets(
  text: string,
  secrets: readonly (string | null | undefined)[] = []
): string {
  let redacted = text
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;"]+/gi, `$1${REDACTED_SECRET}`)
    .replace(/("(?:apiKey|api_key|authorization)"\s*:\s*")[^"]+"/gi, `$1${REDACTED_SECRET}"`);

  for (const secret of secrets) {
    if (!secret) {
      continue;
    }
    redacted = redacted.split(secret).join(REDACTED_SECRET);
  }

  return redacted;
}
