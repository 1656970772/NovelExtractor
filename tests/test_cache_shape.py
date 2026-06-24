"""Tests for cache shape capture and diagnostics."""

from types import SimpleNamespace

from novel_extractor.llm import OpenAICompatibleClient
from novel_extractor.reasonix_compat.cache_shape import capture_shape, compare_shape
from novel_extractor.reasonix_compat.tooling import ToolRegistry


class FakeTool:
    def __init__(self, name: str) -> None:
        self.name = name
        self.description = f"{name} description"
        self.schema = (
            '{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}'
        )
        self.read_only = True

    def execute(self, args):
        return "ok"


def test_cache_shape_normalizes_tool_order():
    a = ToolRegistry()
    b = ToolRegistry()
    a.add(FakeTool("read_file"))
    a.add(FakeTool("grep"))
    b.add(FakeTool("grep"))
    b.add(FakeTool("read_file"))

    assert capture_shape("system", a.openai_tools(), 0).tools_hash == capture_shape("system", b.openai_tools(), 0).tools_hash


def test_cache_shape_reports_tool_change_reason():
    prev = capture_shape("system", [{"function": {"name": "read_file"}}], 0)
    cur = capture_shape("system", [{"function": {"name": "read_file"}}, {"function": {"name": "grep"}}], 0)

    diagnostics = compare_shape(prev, cur, cache_hit_tokens=100, cache_miss_tokens=20)

    assert diagnostics.prefix_changed is True
    assert diagnostics.prefix_change_reasons == ["tools"]


def test_cache_shape_reports_all_shape_reasons():
    prev = capture_shape("system-a", [{"function": {"name": "read_file"}}], 1)
    cur = capture_shape("system-b", [{"function": {"name": "read_file"}}, {"function": {"name": "grep"}}], 2)

    diagnostics = compare_shape(prev, cur, cache_hit_tokens=100, cache_miss_tokens=20)

    assert diagnostics.prefix_change_reasons == ["system", "tools", "rewrite_version"]


def test_cache_shape_includes_full_tool_payload_fields():
    base = [{"type": "function", "function": {"name": "read_file", "description": "d", "parameters": {}}}]
    strict = [
        {
            "type": "function",
            "function": {"name": "read_file", "description": "d", "parameters": {}, "strict": True},
        }
    ]

    assert capture_shape("system", base, 0).tools_hash != capture_shape("system", strict, 0).tools_hash


def test_run_with_tools_reports_cache_diagnostics(monkeypatch):
    class FakeClient:
        def __init__(self):
            self.calls = 0

        class chat:
            class completions:
                pass

    fake_client = FakeClient()

    def create(*args, **kwargs):
        fake_client.calls += 1
        return SimpleNamespace(
            usage=SimpleNamespace(
                prompt_tokens=10,
                completion_tokens=3,
                total_tokens=13,
                prompt_cache_hit_tokens=7,
                prompt_cache_miss_tokens=3,
            ),
            choices=[SimpleNamespace(message=SimpleNamespace(content="done", tool_calls=None))],
        )

    fake_client.chat.completions.create = create

    client = OpenAICompatibleClient.__new__(OpenAICompatibleClient)
    client.client = fake_client
    client.model = "test-model"
    client.temperature = 0.1
    client.max_tool_rounds = 1

    class Reporter:
        def __init__(self):
            self.usage = []
            self.diagnostics = []

        def model_usage(self, usage):
            self.usage.append(usage)

        def model_cache_diagnostics(self, diagnostics):
            self.diagnostics.append(diagnostics)

    reporter = Reporter()

    result = client.run_with_tools("system", "user", ToolRegistry(), reporter=reporter)

    assert result.final_text == "done"
    assert len(reporter.usage) == 1
    assert len(reporter.diagnostics) == 1
    assert reporter.diagnostics[0].prefix_change_reasons == []


def test_run_with_tools_reports_cache_diagnostics_when_usage_object_has_zero_tokens():
    class FakeClient:
        def __init__(self):
            self.calls = 0

        class chat:
            class completions:
                pass

    fake_client = FakeClient()

    def create(*args, **kwargs):
        fake_client.calls += 1
        return SimpleNamespace(
            usage=SimpleNamespace(
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
                prompt_cache_hit_tokens=0,
                prompt_cache_miss_tokens=0,
            ),
            choices=[SimpleNamespace(message=SimpleNamespace(content="done", tool_calls=None))],
        )

    fake_client.chat.completions.create = create

    client = OpenAICompatibleClient.__new__(OpenAICompatibleClient)
    client.client = fake_client
    client.model = "test-model"
    client.temperature = 0.1
    client.max_tool_rounds = 1

    class Reporter:
        def __init__(self):
            self.usage = []
            self.diagnostics = []

        def model_usage(self, usage):
            self.usage.append(usage)

        def model_cache_diagnostics(self, diagnostics):
            self.diagnostics.append(diagnostics)

    reporter = Reporter()

    result = client.run_with_tools("system", "user", ToolRegistry(), reporter=reporter)

    assert result.final_text == "done"
    assert len(reporter.usage) == 0
    assert len(reporter.diagnostics) == 1
    assert reporter.diagnostics[0].cache_hit_tokens == 0
    assert reporter.diagnostics[0].cache_miss_tokens == 0


def test_run_with_tools_reports_prefix_change_across_calls():
    class FakeClient:
        class chat:
            class completions:
                pass

    fake_client = FakeClient()

    def create(*args, **kwargs):
        return SimpleNamespace(
            usage=SimpleNamespace(
                prompt_tokens=10,
                completion_tokens=3,
                total_tokens=13,
                prompt_cache_hit_tokens=0,
                prompt_cache_miss_tokens=10,
            ),
            choices=[SimpleNamespace(message=SimpleNamespace(content="done", tool_calls=None))],
        )

    fake_client.chat.completions.create = create

    client = OpenAICompatibleClient.__new__(OpenAICompatibleClient)
    client.client = fake_client
    client.model = "test-model"
    client.temperature = 0.1
    client.max_tool_rounds = 1

    class Reporter:
        def __init__(self):
            self.diagnostics = []

        def model_usage(self, usage):
            pass

        def model_cache_diagnostics(self, diagnostics):
            self.diagnostics.append(diagnostics)

    reporter = Reporter()

    client.run_with_tools("system-a", "user", ToolRegistry(), reporter=reporter)
    client.run_with_tools("system-b", "user", ToolRegistry(), reporter=reporter)

    assert reporter.diagnostics[0].prefix_change_reasons == []
    assert reporter.diagnostics[1].prefix_change_reasons == ["system"]


def test_run_with_tools_can_disable_cache_diagnostics():
    class FakeClient:
        class chat:
            class completions:
                pass

    fake_client = FakeClient()

    def create(*args, **kwargs):
        return SimpleNamespace(
            usage=SimpleNamespace(
                prompt_tokens=10,
                completion_tokens=3,
                total_tokens=13,
                prompt_cache_hit_tokens=0,
                prompt_cache_miss_tokens=10,
            ),
            choices=[SimpleNamespace(message=SimpleNamespace(content="done", tool_calls=None))],
        )

    fake_client.chat.completions.create = create

    client = OpenAICompatibleClient.__new__(OpenAICompatibleClient)
    client.client = fake_client
    client.model = "test-model"
    client.temperature = 0.1
    client.max_tool_rounds = 1

    class Reporter:
        def __init__(self):
            self.diagnostics = []

        def model_usage(self, usage):
            pass

        def model_cache_diagnostics(self, diagnostics):
            self.diagnostics.append(diagnostics)

    reporter = Reporter()

    client.run_with_tools(
        "system",
        "user",
        ToolRegistry(),
        reporter=reporter,
        diagnose_cache_shape=False,
    )

    assert reporter.diagnostics == []


def test_run_with_tools_persists_shape_when_previous_response_has_no_usage():
    class FakeClient:
        class chat:
            class completions:
                pass

    fake_client = FakeClient()
    responses = [
        SimpleNamespace(
            usage=None,
            choices=[SimpleNamespace(message=SimpleNamespace(content="done", tool_calls=None))],
        ),
        SimpleNamespace(
            usage=SimpleNamespace(
                prompt_tokens=10,
                completion_tokens=3,
                total_tokens=13,
                prompt_cache_hit_tokens=0,
                prompt_cache_miss_tokens=10,
            ),
            choices=[SimpleNamespace(message=SimpleNamespace(content="done", tool_calls=None))],
        ),
    ]

    def create(*args, **kwargs):
        return responses.pop(0)

    fake_client.chat.completions.create = create

    client = OpenAICompatibleClient.__new__(OpenAICompatibleClient)
    client.client = fake_client
    client.model = "test-model"
    client.temperature = 0.1
    client.max_tool_rounds = 1

    class Reporter:
        def __init__(self):
            self.diagnostics = []

        def model_usage(self, usage):
            pass

        def model_cache_diagnostics(self, diagnostics):
            self.diagnostics.append(diagnostics)

    reporter = Reporter()

    client.run_with_tools("system-a", "user", ToolRegistry(), reporter=reporter)
    client.run_with_tools("system-b", "user", ToolRegistry(), reporter=reporter)

    assert reporter.diagnostics[0].prefix_change_reasons == ["system"]
