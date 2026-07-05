import type { FetchedProviderModelDto } from "../shared/ipcTypes";
import { redactSecrets } from "./credentials";

const FETCH_TIMEOUT_MS = 15_000;
const ERROR_BODY_LIMIT = 512;
const KNOWN_COMPAT_SUFFIXES = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude"
] as const;

export interface BuildModelListUrlCandidatesInput {
  baseUrl: string;
  modelsUrl?: string;
  isFullUrl?: boolean;
}

export interface FetchModelsFromProviderInput extends BuildModelListUrlCandidatesInput {
  apiKey: string;
  userAgent?: string;
  fetch?: typeof fetch;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function appendPath(baseUrl: string, path: string): string {
  return `${trimTrailingSlash(baseUrl)}/${path.replace(/^\/+/, "")}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function getLastPathSegment(value: string): string {
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? "";
  } catch {
    const segments = value.split(/[?#]/, 1)[0]?.split("/").filter(Boolean) ?? [];
    return segments.at(-1) ?? "";
  }
}

function buildFullUrlModelListCandidate(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const path = trimTrailingSlash(parsed.pathname);
  parsed.search = "";
  parsed.hash = "";

  const v1Index = path.indexOf("/v1/");
  if (v1Index >= 0) {
    parsed.pathname = path.slice(0, v1Index + "/v1".length);
    return appendPath(trimTrailingSlash(parsed.toString()), "models");
  }

  const lastSlash = path.lastIndexOf("/");
  parsed.pathname = lastSlash > 0 ? path.slice(0, lastSlash) : "/";
  return appendPath(trimTrailingSlash(parsed.toString()), "v1/models");
}

export function buildModelListUrlCandidates(
  input: BuildModelListUrlCandidatesInput
): string[] {
  const modelsUrl = input.modelsUrl?.trim();
  if (modelsUrl) {
    return [modelsUrl];
  }

  const baseUrl = trimTrailingSlash(input.baseUrl.trim());
  if (!baseUrl) {
    return [];
  }

  if (input.isFullUrl) {
    return unique([buildFullUrlModelListCandidate(baseUrl)]);
  }

  const candidates: string[] = [];
  const lastSegment = getLastPathSegment(baseUrl);
  if (/^v\d+$/i.test(lastSegment)) {
    pushUnique(candidates, appendPath(baseUrl, "models"));
    if (lastSegment.toLowerCase() !== "v1") {
      pushUnique(candidates, appendPath(baseUrl, "v1/models"));
    }
  } else {
    pushUnique(candidates, appendPath(baseUrl, "v1/models"));
  }

  for (const suffix of KNOWN_COMPAT_SUFFIXES) {
    if (!baseUrl.endsWith(suffix)) {
      continue;
    }
    const rootUrl = trimTrailingSlash(baseUrl.slice(0, -suffix.length));
    pushUnique(candidates, appendPath(rootUrl, "v1/models"));
    pushUnique(candidates, appendPath(rootUrl, "models"));
    break;
  }
  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseFetchedModels(payload: unknown): FetchedProviderModelDto[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }

  return payload.data
    .flatMap((item): FetchedProviderModelDto[] => {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
        return [];
      }
      return [
        {
          id: item.id,
          ownedBy: typeof item.owned_by === "string" ? item.owned_by : undefined
        }
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text();
  return text.slice(0, ERROR_BODY_LIMIT);
}

async function buildSafeHttpErrorMessage(
  url: string,
  response: Response,
  apiKey: string
): Promise<string> {
  const body = await readErrorBody(response);
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return redactSecrets(
    `Failed to fetch provider models from ${url}: HTTP ${response.status}${statusText}: ${body}`,
    [apiKey]
  );
}

function createAbortSignal(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout)
  };
}

export async function fetchModelsFromProvider(
  input: FetchModelsFromProviderInput
): Promise<FetchedProviderModelDto[]> {
  const fetchImpl = input.fetch ?? fetch;
  const candidates = buildModelListUrlCandidates(input);
  let lastCandidateError = "no URL candidates";

  for (const url of candidates) {
    const { signal, cleanup } = createAbortSignal(FETCH_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${input.apiKey}`
      };
      if (input.userAgent?.trim()) {
        headers["User-Agent"] = input.userAgent.trim();
      }

      const response = await fetchImpl(url, { headers, signal });
      if (response.status === 404 || response.status === 405) {
        lastCandidateError = await buildSafeHttpErrorMessage(url, response, input.apiKey);
        continue;
      }
      if (!response.ok) {
        throw new Error(await buildSafeHttpErrorMessage(url, response, input.apiKey));
      }

      return parseFetchedModels(await response.json());
    } finally {
      cleanup();
    }
  }

  throw new Error(`All candidates failed: ${lastCandidateError}`);
}
