"""LLM client implementations with cache optimization."""

import os
from pathlib import Path
from typing import Protocol

from openai import OpenAI

from novel_extractor.reasonix_compat.cache_shape import capture_shape, compare_shape
from novel_extractor.reasonix_compat.tool_budget import ToolOutputBudget, elide_stale_tool_messages
from novel_extractor.reasonix_compat.tooling import ToolLoopResult, ToolRegistry
from novel_extractor.reasonix_compat.usage import normalize_usage


class LLMClient(Protocol):
    """Protocol for LLM clients."""

    def complete(self, prompt: str) -> str:
        """Complete a prompt and return the response."""
        raise NotImplementedError

    def complete_with_cache(self, system_prompt: str, user_prompt: str) -> str:
        """Complete with system/user split for cache optimization."""
        raise NotImplementedError

    def run_with_tools(
        self,
        system_prompt: str,
        user_prompt: str,
        registry: ToolRegistry,
        reporter=None,
        tool_budget: ToolOutputBudget | None = None,
        diagnose_cache_shape: bool = True,
    ) -> ToolLoopResult:
        """Run a Reasonix-style tool calling loop."""
        raise NotImplementedError


class FakeLLMClient:
    """Fake LLM client for testing."""

    def __init__(self, responses_by_substring: dict[str, str]) -> None:
        self.responses = responses_by_substring

    def complete(self, prompt: str) -> str:
        """Return pre-configured response based on substring match."""
        for substring, response in self.responses.items():
            if substring in prompt:
                return response
        return "NO_UPDATE"

    def complete_with_cache(self, system_prompt: str, user_prompt: str) -> str:
        """Return pre-configured response based on substring match."""
        combined = system_prompt + "\n\n" + user_prompt
        return self.complete(combined)

    def run_with_tools(
        self,
        system_prompt: str,
        user_prompt: str,
        registry: ToolRegistry,
        reporter=None,
        tool_budget: ToolOutputBudget | None = None,
        diagnose_cache_shape: bool = True,
    ) -> ToolLoopResult:
        """Fake tool loop: return the configured text without tool calls."""
        return ToolLoopResult(final_text=self.complete(system_prompt + "\n\n" + user_prompt), usage_events=[])


class OpenAICompatibleClient:
    """OpenAI-compatible LLM client with cache support."""

    def __init__(
        self,
        base_url: str | None,
        api_key: str,
        model: str,
        temperature: float,
        timeout_seconds: int,
        max_retries: int,
        enable_cache: bool = True,
        max_tool_rounds: int = 12,
    ) -> None:
        self.model = model
        self.temperature = temperature
        self.timeout_seconds = timeout_seconds
        self.max_retries = max_retries
        self.enable_cache = enable_cache
        self.max_tool_rounds = max_tool_rounds
        self._previous_cache_shape = None

        self.client = OpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout_seconds,
            max_retries=max_retries,
        )

    def complete(self, prompt: str) -> str:
        """Send prompt to LLM and return response (legacy mode, no cache)."""
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=self.temperature,
        )

        return response.choices[0].message.content or ""

    def run_with_tools(
        self,
        system_prompt: str,
        user_prompt: str,
        registry: ToolRegistry,
        reporter=None,
        tool_budget: ToolOutputBudget | None = None,
        diagnose_cache_shape: bool = True,
    ) -> ToolLoopResult:
        """Run OpenAI-compatible tool calling using Reasonix-style tools."""
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        tools = registry.openai_tools()
        current_shape = None
        previous_shape = None
        if diagnose_cache_shape:
            current_shape = capture_shape(system_prompt, tools, 0)
            previous_shape = getattr(self, "_previous_cache_shape", None) or current_shape
        usage_events = []

        for _ in range(self.max_tool_rounds):
            request_messages = messages
            if tool_budget is not None and tool_budget.elide_stale_results:
                request_messages = elide_stale_tool_messages(
                    messages,
                    min_elide_chars=tool_budget.min_elide_chars,
                    recent_keep=1,
                )
            response = self.client.chat.completions.create(
                model=self.model,
                messages=request_messages,
                tools=tools,
                tool_choice="auto",
                temperature=self.temperature,
            )

            raw_usage = getattr(response, "usage", None)
            usage = normalize_usage(raw_usage)
            if usage.total_tokens:
                usage_events.append(usage)
                if reporter is not None and hasattr(reporter, "model_usage"):
                    reporter.model_usage(usage)
            if raw_usage is not None and diagnose_cache_shape:
                diagnostics = compare_shape(
                    previous_shape,
                    current_shape,
                    cache_hit_tokens=usage.cache_hit_tokens,
                    cache_miss_tokens=usage.cache_miss_tokens,
                )
                if reporter is not None and hasattr(reporter, "model_cache_diagnostics"):
                    reporter.model_cache_diagnostics(diagnostics)
                previous_shape = current_shape
                self._previous_cache_shape = current_shape

            message = response.choices[0].message
            tool_calls = getattr(message, "tool_calls", None) or []
            if not tool_calls:
                if diagnose_cache_shape:
                    self._previous_cache_shape = current_shape
                return ToolLoopResult(final_text=message.content or "", usage_events=usage_events)

            messages.append(
                {
                    "role": "assistant",
                    "content": message.content or "",
                    "tool_calls": [_dump_tool_call(tool_call) for tool_call in tool_calls],
                }
            )
            for tool_call in tool_calls:
                name = tool_call.function.name
                args = tool_call.function.arguments or "{}"
                try:
                    result = registry.execute(name, args)
                except Exception as exc:
                    result = f"error: {exc}"
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": name,
                        "content": result,
                    }
                )

        raise RuntimeError(f"tool loop exceeded {self.max_tool_rounds} rounds")

    def complete_with_cache(self, system_prompt: str, user_prompt: str) -> str:
        """Send prompt to LLM with cache optimization.

        DeepSeek caches the system message prefix, so:
        - system_prompt contains templates (cacheable, ~5000 tokens)
        - user_prompt contains current chapters (non-cacheable, ~20000 tokens)

        Expected cache hit rate: ~20% tokens
        Expected cost savings: ~20%
        """
        if self.enable_cache:
            # Split into system + user for cache optimization
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ]
        else:
            # Fallback: combine into single user message
            messages = [{"role": "user", "content": system_prompt + "\n\n" + user_prompt}]

        response = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=self.temperature,
        )

        return response.choices[0].message.content or ""


def create_llm_client_from_config(llm_config, enable_cache: bool = True) -> LLMClient:
    """Create LLM client from configuration.

    Args:
        llm_config: LLM configuration from config file
        enable_cache: Enable DeepSeek cache optimization (default: True)
    """
    base_url = os.getenv(llm_config.base_url_env) or "https://api.deepseek.com"
    api_key = _resolve_api_key(llm_config.api_key_env, getattr(llm_config, "credentials_file", None))
    model = os.getenv(llm_config.model_env, llm_config.default_model)

    if not api_key:
        if getattr(llm_config, "credentials_file", None):
            raise ValueError(
                f"API key {llm_config.api_key_env} is not set in {llm_config.credentials_file} or environment"
            )
        raise ValueError(f"Environment variable {llm_config.api_key_env} is not set")
    if _is_placeholder_api_key(api_key):
        source = f" in {llm_config.credentials_file}" if getattr(llm_config, "credentials_file", None) else ""
        raise ValueError(f"API key {llm_config.api_key_env}{source} is still a placeholder; replace it with a valid key")

    return OpenAICompatibleClient(
        base_url=base_url,
        api_key=api_key,
        model=model,
        temperature=llm_config.temperature,
        timeout_seconds=llm_config.timeout_seconds,
        max_retries=llm_config.max_retries,
        enable_cache=enable_cache,
    )


def _dump_tool_call(tool_call) -> dict:
    """Convert SDK tool call objects to OpenAI message dicts."""
    return {
        "id": tool_call.id,
        "type": "function",
        "function": {
            "name": tool_call.function.name,
            "arguments": tool_call.function.arguments or "{}",
        },
    }


def _resolve_api_key(env_name: str, credentials_file: str | Path | None) -> str | None:
    """Resolve provider credentials with Reasonix-style .env support."""
    if credentials_file is not None:
        value = _read_dotenv_value(Path(credentials_file), env_name)
        if value:
            return value
    return os.getenv(env_name)


def _is_placeholder_api_key(value: str) -> bool:
    normalized = value.strip().lower()
    return normalized in {"your-api-key", "your-api-key-here"}


def _read_dotenv_value(path: Path, env_name: str) -> str | None:
    if not path.exists():
        return None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line.removeprefix("export ").strip()
        key, separator, value = line.partition("=")
        if not separator or key.strip() != env_name:
            continue
        return value.strip().strip("\"'")
    return None
