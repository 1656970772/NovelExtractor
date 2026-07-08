import type { LlmFailurePolicyDefaults } from "@novel-extractor/config";
import { OpenAiCompatibleRequestError } from "@novel-extractor/llm";

export interface LlmFailureClassification {
  switchable: boolean;
  retryable: boolean;
  reason: "http_status" | "message_fragment" | "network_fragment" | "not_llm_request_error";
  detail?: string;
}

function includesFragment(value: string, fragments: readonly string[]): string | undefined {
  const normalized = value.toLowerCase();

  return fragments.find((fragment) => normalized.includes(fragment.toLowerCase()));
}

function collectErrorText(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const fragments: string[] = [];
  const error = record.error;

  if (error && typeof error === "object" && !Array.isArray(error)) {
    fragments.push(...stringFields(error as Record<string, unknown>, ["message", "code", "type"]));
  }

  fragments.push(...stringFields(record, ["message", "code", "type"]));
  return fragments;
}

function stringFields(record: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields
    .map((field) => record[field])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function stringifyForClassification(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function classifyLlmFailure(
  error: unknown,
  defaults: LlmFailurePolicyDefaults
): LlmFailureClassification {
  if (!(error instanceof OpenAiCompatibleRequestError)) {
    return {
      switchable: false,
      retryable: false,
      reason: "not_llm_request_error"
    };
  }

  if (
    error.kind === "http" &&
    error.details.status !== undefined &&
    defaults.switchableHttpStatuses.includes(error.details.status)
  ) {
    return {
      switchable: true,
      retryable: true,
      reason: "http_status",
      detail: String(error.details.status)
    };
  }

  if (error.kind === "network" || error.kind === "response_body") {
    const text = `${error.message}\n${stringifyForClassification(error.details.body)}`;
    const networkFragment = includesFragment(text, defaults.switchableNetworkErrorFragments);
    if (networkFragment) {
      return {
        switchable: true,
        retryable: true,
        reason: "network_fragment",
        detail: networkFragment
      };
    }

    return {
      switchable: false,
      retryable: false,
      reason: "network_fragment"
    };
  }

  const httpErrorText = [error.message, ...collectErrorText(error.details.body)].join("\n");
  const messageFragment = includesFragment(httpErrorText, defaults.switchableMessageFragments);
  if (messageFragment) {
    return {
      switchable: true,
      retryable: true,
      reason: "message_fragment",
      detail: messageFragment
    };
  }

  return {
    switchable: false,
    retryable: false,
    reason: "message_fragment"
  };
}
