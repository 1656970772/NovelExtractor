from types import SimpleNamespace

from novel_extractor.llm import OpenAICompatibleClient
from novel_extractor.reasonix_compat.tool_budget import ToolOutputBudget, elide_stale_tool_messages
from novel_extractor.reasonix_compat.tooling import ToolRegistry


def test_tool_output_budget_truncates_large_result():
    budget = ToolOutputBudget(max_tool_result_chars=20)

    assert budget.apply("read_file", "x" * 50) == "[truncated read_file result: 50 chars, showing first 20]\n" + "x" * 20


def test_elide_stale_tool_messages_keeps_recent_tail():
    messages = [
        {"role": "tool", "name": "read_file", "content": "a" * 3000},
        {"role": "assistant", "content": "ok"},
        {"role": "tool", "name": "grep", "content": "b" * 3000},
    ]

    result = elide_stale_tool_messages(messages, min_elide_chars=2048, recent_keep=1)

    assert "elided tool result" in result[0]["content"]
    assert result[2]["content"] == "b" * 3000


def test_run_with_tools_elides_stale_tool_results_before_next_request():
    captured_messages = []

    class FakeClient:
        class chat:
            class completions:
                pass

    fake_client = FakeClient()
    responses = [
        SimpleNamespace(
            usage=None,
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content="",
                        tool_calls=[
                            SimpleNamespace(
                                id="call-read",
                                function=SimpleNamespace(name="read_file", arguments="{}"),
                            )
                        ],
                    )
                )
            ],
        ),
        SimpleNamespace(
            usage=None,
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content="",
                        tool_calls=[
                            SimpleNamespace(
                                id="call-grep",
                                function=SimpleNamespace(name="grep", arguments="{}"),
                            )
                        ],
                    )
                )
            ],
        ),
        SimpleNamespace(
            usage=None,
            choices=[SimpleNamespace(message=SimpleNamespace(content="done", tool_calls=None))],
        ),
    ]

    def create(*args, **kwargs):
        captured_messages.append(kwargs["messages"])
        return responses.pop(0)

    fake_client.chat.completions.create = create

    class BigTool:
        description = "big"
        schema = "{}"
        read_only = True

        def __init__(self, name: str, content: str) -> None:
            self.name = name
            self.content = content

        def execute(self, args):
            return self.content

    registry = ToolRegistry()
    registry.add(BigTool("read_file", "a" * 50))
    registry.add(BigTool("grep", "b" * 50))

    client = OpenAICompatibleClient.__new__(OpenAICompatibleClient)
    client.client = fake_client
    client.model = "test-model"
    client.temperature = 0.1
    client.max_tool_rounds = 3

    result = client.run_with_tools(
        "system",
        "user",
        registry,
        tool_budget=ToolOutputBudget(min_elide_chars=10),
    )

    third_request = captured_messages[2]
    tool_messages = [message for message in third_request if message["role"] == "tool"]
    assert result.final_text == "done"
    assert "elided tool result" in tool_messages[0]["content"]
    assert tool_messages[1]["content"] == "b" * 50
