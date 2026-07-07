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

  const text = `${error.message}\n${stringifyForClassification(error.details.body)}`;
  if (error.kind === "network" || error.kind === "response_body") {
    const networkFragment = includesFragment(text, defaults.switchableNetworkErrorFragments);
    if (networkFragment) {
      return {
        switchable: true,
        retryable: true,
        reason: "network_fragment",
        detail: networkFragment
      };
    }
  }

  const messageFragment = includesFragment(text, defaults.switchableMessageFragments);
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
    reason: error.kind === "http" ? "message_fragment" : "network_fragment"
  };
}
