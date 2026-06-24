from novel_extractor.token_saving import PromptBudgeter


def test_prompt_budgeter_warns_above_warn_ratio():
    budgeter = PromptBudgeter(context_window=1000, warn_ratio=0.5, hard_ratio=0.8)

    decision = budgeter.evaluate(system_prompt="x" * 1200, user_prompt="y" * 900)

    assert decision.level == "warn"


def test_prompt_budgeter_hard_split_above_hard_ratio():
    budgeter = PromptBudgeter(context_window=1000, warn_ratio=0.5, hard_ratio=0.8, strategy="split")

    decision = budgeter.evaluate(system_prompt="x" * 2000, user_prompt="y" * 2000)

    assert decision.level == "hard"
    assert decision.action == "split"
