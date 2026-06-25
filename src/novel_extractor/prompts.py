"""Prompt building for extraction tasks with cache optimization."""

from novel_extractor.chapters import Chapter


def build_system_prompt(template_texts: dict[str, str]) -> str:
    """Build system prompt with templates (cacheable prefix).

    This part stays constant across windows and can be cached by DeepSeek.
    """
    parts = []

    # Instructions
    parts.append("## 任务说明\n")
    parts.append("你是一个小说信息提取助手。你需要从章节中提取信息，按照模板要求写入对应文档。\n")
    parts.append("\n**重要规则**：")
    parts.append("- 上下文章节仅用于理解背景，默认只提交 commit 范围内的新发现")
    parts.append("- 新章节可以回补旧章节的条目，但必须注明来源章节")
    parts.append("- 相同名称的条目，先参考已有片段，完整则跳过，不完整则补充")
    parts.append("- 所有新增事实必须来自当前窗口章节，不允许凭印象补全")
    parts.append("- **不要输出业务 JSON**；需要修改时必须调用写入工具")
    parts.append("- 写入前必须使用 grep 或 read_file 查询目标文档，确认是否已有重复条目")
    parts.append("- 使用 write_file 或 edit_file 直接写入 Markdown 文档")
    parts.append("- 如果没有任何可写内容，最终回答必须精确输出 NO_UPDATE")
    parts.append("\n---\n")

    # Templates (cacheable part)
    parts.append("## 模板\n")
    for filename in sorted(template_texts):
        content = template_texts[filename]
        parts.append(f"\n### {filename}\n")
        parts.append(content)
        parts.append("\n")

    return "".join(parts)


def build_user_prompt(
    novel_id: str,
    window_id: str,
    context_chapters: list[Chapter],
    commit_chapters: list[Chapter],
    existing_snippets: dict[str, str],
) -> str:
    """Build user prompt with current window content (non-cacheable).

    This part changes for each window and cannot be cached.
    """
    context_numbers = ", ".join(str(ch.number) for ch in context_chapters)
    commit_numbers = ", ".join(str(ch.number) for ch in commit_chapters)

    parts = []

    # Header
    parts.append(f"# 《{novel_id}》信息提取任务")
    parts.append(f"\n窗口：{window_id}")
    parts.append(f"上下文章节：{context_numbers}")
    parts.append(f"本轮默认提交章节：{commit_numbers}")
    parts.append("\n---\n")

    # Existing snippets
    if existing_snippets:
        parts.append("\n## 已有片段（用于去重）\n")
        for key, snippet in existing_snippets.items():
            parts.append(f"\n### {key}\n")
            parts.append(snippet)
            parts.append("\n")
        parts.append("\n---\n")

    # Chapter content
    parts.append("## 章节内容\n")
    for chapter in context_chapters:
        parts.append(f"\n### {chapter.title}\n")
        parts.append(chapter.body)
        parts.append("\n")

    return "".join(parts)


def build_extraction_prompt(
    novel_id: str,
    window_id: str,
    context_chapters: list[Chapter],
    commit_chapters: list[Chapter],
    template_texts: dict[str, str],
    existing_snippets: dict[str, str],
) -> str:
    """Build extraction prompt with Markdown update contract.

    DEPRECATED: Use build_system_prompt + build_user_prompt for cache optimization.
    This function is kept for backward compatibility.
    """
    context_numbers = ", ".join(str(ch.number) for ch in context_chapters)
    commit_numbers = ", ".join(str(ch.number) for ch in commit_chapters)

    prompt_parts = []

    # Header
    prompt_parts.append(f"# 《{novel_id}》信息提取任务")
    prompt_parts.append(f"\n窗口：{window_id}")
    prompt_parts.append(f"上下文章节：{context_numbers}")
    prompt_parts.append(f"本轮默认提交章节：{commit_numbers}")
    prompt_parts.append("\n---\n")

    # Instructions
    prompt_parts.append("## 任务说明\n")
    prompt_parts.append("你需要从当前窗口的章节中提取信息，按照模板要求写入对应文档。\n")
    prompt_parts.append("\n**重要规则**：")
    prompt_parts.append("- 上下文章节仅用于理解背景，默认只提交 commit 范围内的新发现")
    prompt_parts.append("- 新章节可以回补旧章节的条目，但必须注明来源章节")
    prompt_parts.append("- 相同名称的条目，先参考已有片段，完整则跳过，不完整则补充")
    prompt_parts.append("- 所有新增事实必须来自当前窗口章节，不允许凭印象补全")
    prompt_parts.append("- **不要输出业务 JSON**；需要修改时必须调用写入工具")
    prompt_parts.append("- 写入前必须使用 grep 或 read_file 查询目标文档，确认是否已有重复条目")
    prompt_parts.append("- 使用 write_file、edit_file 或 multi_edit 直接写入 Markdown 文档")
    prompt_parts.append("- 如果没有任何可写内容，最终回答必须精确输出 NO_UPDATE")
    prompt_parts.append("\n---\n")

    # Templates
    prompt_parts.append("## 模板\n")
    for filename in sorted(template_texts):
        content = template_texts[filename]
        prompt_parts.append(f"\n### {filename}\n")
        prompt_parts.append(content)
        prompt_parts.append("\n")

    # Existing snippets
    if existing_snippets:
        prompt_parts.append("\n---\n")
        prompt_parts.append("## 已有片段（用于去重）\n")
        for key, snippet in existing_snippets.items():
            prompt_parts.append(f"\n### {key}\n")
            prompt_parts.append(snippet)
            prompt_parts.append("\n")

    # Chapter content
    prompt_parts.append("\n---\n")
    prompt_parts.append("## 章节内容\n")
    for chapter in context_chapters:
        prompt_parts.append(f"\n### {chapter.title}\n")
        prompt_parts.append(chapter.body)
        prompt_parts.append("\n")

    return "".join(prompt_parts)
