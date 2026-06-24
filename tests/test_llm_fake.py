"""Tests for LLM client."""

import pytest

from novel_extractor.llm import FakeLLMClient
from novel_extractor.config import LLMConfig
from novel_extractor.llm import create_llm_client_from_config


def test_fake_llm_returns_configured_response():
    client = FakeLLMClient({"窗口：1-5": "NO_UPDATE"})

    assert client.complete("窗口：1-5\n正文") == "NO_UPDATE"


def test_deepseek_client_defaults_base_url_when_env_missing(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.delenv("DEEPSEEK_BASE_URL", raising=False)
    monkeypatch.delenv("DEEPSEEK_MODEL", raising=False)

    client = create_llm_client_from_config(
        LLMConfig(
            provider="openai_compatible",
            base_url_env="DEEPSEEK_BASE_URL",
            api_key_env="DEEPSEEK_API_KEY",
            model_env="DEEPSEEK_MODEL",
            default_model="deepseek-v4-flash",
            temperature=0.2,
            timeout_seconds=120,
            max_retries=2,
            pricing=None,
        )
    )

    assert client.model == "deepseek-v4-flash"
    assert str(client.client.base_url).rstrip("/") == "https://api.deepseek.com"


def test_deepseek_client_reads_api_key_from_credentials_file(monkeypatch, tmp_path):
    credentials_file = tmp_path / ".env"
    credentials_file.write_text(
        '\n# local credentials\nexport DEEPSEEK_API_KEY="file-key"\n',
        encoding="utf-8",
    )
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    class CapturingOpenAI:
        def __init__(self, **kwargs):
            self.api_key = kwargs["api_key"]
            self.base_url = kwargs["base_url"]

    monkeypatch.setattr("novel_extractor.llm.OpenAI", CapturingOpenAI)

    client = create_llm_client_from_config(
        LLMConfig(
            provider="openai_compatible",
            base_url_env="DEEPSEEK_BASE_URL",
            api_key_env="DEEPSEEK_API_KEY",
            model_env="DEEPSEEK_MODEL",
            default_model="deepseek-v4-flash",
            temperature=0.2,
            timeout_seconds=120,
            max_retries=2,
            pricing=None,
            credentials_file=credentials_file,
        )
    )

    assert client.client.api_key == "file-key"


def test_deepseek_credentials_file_overrides_process_env(monkeypatch, tmp_path):
    credentials_file = tmp_path / ".env"
    credentials_file.write_text("DEEPSEEK_API_KEY=file-key\n", encoding="utf-8")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "env-key")

    class CapturingOpenAI:
        def __init__(self, **kwargs):
            self.api_key = kwargs["api_key"]
            self.base_url = kwargs["base_url"]

    monkeypatch.setattr("novel_extractor.llm.OpenAI", CapturingOpenAI)

    client = create_llm_client_from_config(
        LLMConfig(
            provider="openai_compatible",
            base_url_env="DEEPSEEK_BASE_URL",
            api_key_env="DEEPSEEK_API_KEY",
            model_env="DEEPSEEK_MODEL",
            default_model="deepseek-v4-flash",
            temperature=0.2,
            timeout_seconds=120,
            max_retries=2,
            pricing=None,
            credentials_file=credentials_file,
        )
    )

    assert client.client.api_key == "file-key"


def test_deepseek_client_rejects_example_placeholder_api_key(monkeypatch, tmp_path):
    credentials_file = tmp_path / ".env"
    credentials_file.write_text("DEEPSEEK_API_KEY=your-api-key-here\n", encoding="utf-8")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    with pytest.raises(ValueError, match="placeholder"):
        create_llm_client_from_config(
            LLMConfig(
                provider="openai_compatible",
                base_url_env="DEEPSEEK_BASE_URL",
                api_key_env="DEEPSEEK_API_KEY",
                model_env="DEEPSEEK_MODEL",
                default_model="deepseek-v4-flash",
                temperature=0.2,
                timeout_seconds=120,
                max_retries=2,
                pricing=None,
                credentials_file=credentials_file,
            )
        )
