"""Reasonix-compatible built-in tools - direct Python port from DeepSeek-Reasonix."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class ReadFileTool:
    """Read a text file with optional line offset/limit."""

    work_dir: str = ""
    ledger: Any = None
    _budget: Any = None

    @property
    def name(self) -> str:
        return "read_file"

    @property
    def description(self) -> str:
        return (
            "Read a text file with optional line offset/limit. Output prefixes each line with its 1-based number "
            "(e.g. `   42→...`) so subsequent edit_file calls can target exact lines. Use `offset` and `limit` to "
            "page through large files; the tool reports total length and pagination hints in a trailer."
        )

    @property
    def schema(self) -> str:
        return json.dumps({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path"},
                "offset": {"type": "integer", "description": "0-based line offset to start reading from (default 0)", "minimum": 0},
                "limit": {"type": "integer", "description": "Maximum lines to return (default 2000)", "minimum": 1}
            },
            "required": ["path"]
        })

    @property
    def read_only(self) -> bool:
        return True

    def execute(self, args: dict[str, Any]) -> str:
        path_str = args.get("path", "")
        if not path_str:
            raise ValueError("path is required")

        path = self._resolve_in(path_str)
        offset = max(args.get("offset", 0), 0)

        # Use budget's default limit if not specified in args
        if "limit" in args and args["limit"] is not None:
            limit = args["limit"]
        else:
            # Get default from budget (accessed through tool's attribute if available)
            limit = 2000
            if hasattr(self, '_budget') and self._budget is not None:
                limit = self._budget.read_file_default_limit

        if limit <= 0:
            limit = 2000

        # Check if directory
        if os.path.isdir(path):
            raise ValueError(f"{path} is a directory, not a file — use the ls tool to list it, or read a specific file inside it")

        # Read file
        try:
            with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
                lines = f.readlines()
        except FileNotFoundError:
            raise ValueError(f"read {path}: file not found")
        except Exception as e:
            raise ValueError(f"read {path}: {e}")

        # Strip newlines
        lines = [line.rstrip('\r\n') for line in lines]

        if len(lines) == 0:
            return "(empty file)"

        if offset >= len(lines):
            return f"(offset {offset} is past EOF — file has {len(lines)} lines)"

        # Select lines
        selected = lines[offset:offset + limit]
        has_more = offset + limit < len(lines)

        # Format output with fixed width of 4 for line numbers
        result = []
        for i, line in enumerate(selected):
            line_num = offset + i + 1
            result.append(f"{line_num:4}→{line}")

        # Add total lines info
        result.append(f"... total lines: {len(lines)}")

        if has_more:
            result.append(f"... next offset: {offset + len(selected)}")

        # Record query to ledger
        if self.ledger is not None:
            self.ledger.record_query(self.name, path)

        return "\n".join(result)

    def _resolve_in(self, path: str) -> str:
        """Resolve path relative to work_dir."""
        if not self.work_dir:
            return os.path.abspath(path)
        p = Path(path)
        if p.is_absolute():
            return str(p)
        return str(Path(self.work_dir) / p)


@dataclass
class WriteFileTool:
    """Write content to a file at the given path."""

    roots: list[str] = None
    work_dir: str = ""
    ledger: Any = None

    def __post_init__(self):
        if self.roots is None:
            self.roots = []

    @property
    def name(self) -> str:
        return "write_file"

    @property
    def description(self) -> str:
        return "Write content to a file at the given path (overwriting existing content). Creates parent directories as needed."

    @property
    def schema(self) -> str:
        return json.dumps({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path"},
                "content": {"type": "string", "description": "Full content to write"}
            },
            "required": ["path", "content"]
        })

    @property
    def read_only(self) -> bool:
        return False

    def execute(self, args: dict[str, Any]) -> str:
        path_str = args.get("path", "")
        if not path_str:
            raise ValueError("path is required")

        content = args.get("content", "")
        path = self._resolve_in(path_str)

        if self.roots:
            self._confine(path)

        # Check if content already matches
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8', errors='replace') as f:
                    existing = f.read()
                if existing == content:
                    return f"{path} already contains the exact content; no changes made"
            except Exception:
                pass

        # Create parent directories
        parent = os.path.dirname(path)
        if parent and parent != ".":
            os.makedirs(parent, exist_ok=True)

        # Write file
        try:
            with open(path, 'w', encoding='utf-8', newline='') as f:
                f.write(content)
        except Exception as e:
            raise ValueError(f"write {path}: {e}")

        # Record write to ledger
        if self.ledger is not None:
            self.ledger.record_write(self.name, path, content)

        return f"wrote {len(content)} bytes to {path}"

    def _resolve_in(self, path: str) -> str:
        """Resolve path relative to work_dir."""
        if not self.work_dir:
            return os.path.abspath(path)
        p = Path(path)
        if p.is_absolute():
            return str(p)
        return str(Path(self.work_dir) / p)

    def _confine(self, path: str) -> None:
        """Check if path is within allowed roots."""
        if not self.roots:
            return
        abs_path = os.path.abspath(path)
        for root in self.roots:
            abs_root = os.path.abspath(root)
            try:
                os.path.relpath(abs_path, abs_root)
                if abs_path.startswith(abs_root):
                    return
            except ValueError:
                continue
        raise ValueError(f"path is outside workspace: {path}")


@dataclass
class EditFileTool:
    """Replace an exact string in a file with another."""

    roots: list[str] = None
    work_dir: str = ""
    ledger: Any = None

    def __post_init__(self):
        if self.roots is None:
            self.roots = []

    @property
    def name(self) -> str:
        return "edit_file"

    @property
    def description(self) -> str:
        return "Replace an exact string in a file with another. old_string must occur exactly once; add surrounding context to disambiguate. Use for targeted edits instead of rewriting the whole file."

    @property
    def schema(self) -> str:
        return json.dumps({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path"},
                "old_string": {"type": "string", "description": "Exact text to replace (must be unique in the file)"},
                "new_string": {"type": "string", "description": "Replacement text (may be empty to delete)"}
            },
            "required": ["path", "old_string", "new_string"]
        })

    @property
    def read_only(self) -> bool:
        return False

    def execute(self, args: dict[str, Any]) -> str:
        path_str = args.get("path", "")
        if not path_str:
            raise ValueError("path is required")

        old_string = args.get("old_string", "")
        if not old_string:
            raise ValueError("old_string is required")

        new_string = args.get("new_string", "")
        path = self._resolve_in(path_str)

        if self.roots:
            self._confine(path)

        # Read file
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
        except Exception as e:
            raise ValueError(f"read {path}: {e}")

        # Match line endings
        old, new = self._match_line_endings(content, old_string, new_string)

        # Check occurrence count
        count = content.count(old)
        if count == 0:
            raise ValueError(f"old_string not found in {path}")
        elif count > 1:
            raise ValueError(f"old_string is not unique in {path}; add more surrounding context")

        # Replace
        updated = content.replace(old, new, 1)

        # Write back
        try:
            with open(path, 'w', encoding='utf-8', newline='') as f:
                f.write(updated)
        except Exception as e:
            raise ValueError(f"write {path}: {e}")

        # Record write to ledger
        if self.ledger is not None:
            self.ledger.record_write(self.name, path, new_string)

        return f"edited {path}"

    def _resolve_in(self, path: str) -> str:
        """Resolve path relative to work_dir."""
        if not self.work_dir:
            return os.path.abspath(path)
        p = Path(path)
        if p.is_absolute():
            return str(p)
        return str(Path(self.work_dir) / p)

    def _confine(self, path: str) -> None:
        """Check if path is within allowed roots."""
        if not self.roots:
            return
        abs_path = os.path.abspath(path)
        for root in self.roots:
            abs_root = os.path.abspath(root)
            try:
                os.path.relpath(abs_path, abs_root)
                if abs_path.startswith(abs_root):
                    return
            except ValueError:
                continue
        raise ValueError(f"path is outside workspace: {path}")

    def _match_line_endings(self, content: str, old_string: str, new_string: str) -> tuple[str, str]:
        """Match line endings between content and strings."""
        # Detect line ending in content
        has_crlf = '\r\n' in content
        has_lf = '\n' in content and not has_crlf

        # Normalize old_string
        old_normalized = old_string
        if has_crlf and '\n' in old_string and '\r\n' not in old_string:
            old_normalized = old_string.replace('\n', '\r\n')
        elif has_lf and '\r\n' in old_string:
            old_normalized = old_string.replace('\r\n', '\n')

        # Normalize new_string
        new_normalized = new_string
        if has_crlf and '\n' in new_string and '\r\n' not in new_string:
            new_normalized = new_string.replace('\n', '\r\n')
        elif has_lf and '\r\n' in new_string:
            new_normalized = new_string.replace('\r\n', '\n')

        return old_normalized, new_normalized


@dataclass
class GrepTool:
    """Search for a regular expression in files."""

    work_dir: str = ""
    rg_path: str = ""
    ledger: Any = None
    max_matches: int = 200

    @property
    def name(self) -> str:
        return "grep"

    @property
    def description(self) -> str:
        if self.rg_path:
            return "Search for a regular expression in a file, or recursively under a directory — ripgrep-backed, so it honors .gitignore. Returns matching lines as path:line:text, capped at 200 matches."
        return "Search for a regular expression in a file, or recursively under a directory (skips hidden files and files matched by .gitignore). Returns matching lines as path:line:text, capped at 200 matches."

    @property
    def schema(self) -> str:
        return json.dumps({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regular expression (RE2 syntax)"},
                "path": {"type": "string", "description": "File or directory to search (default \".\")"},
                "timeout_seconds": {
                    "type": "integer",
                    "description": "Abort and return partial matches after this many seconds (default 30, max 300). Raise it for a large tree; lower it for a quick probe.",
                    "minimum": 1
                }
            },
            "required": ["pattern"]
        })

    @property
    def read_only(self) -> bool:
        return True

    def execute(self, args: dict[str, Any]) -> str:
        pattern = args.get("pattern", "")
        if not pattern:
            raise ValueError("pattern is required")

        path_str = args.get("path", ".")
        path = self._resolve_in(path_str)

        # Compile regex
        try:
            regex = re.compile(pattern)
        except re.error as e:
            raise ValueError(f"invalid pattern: {e}")

        matches = []

        # Check if path is file or directory
        if os.path.isfile(path):
            self._search_file(path, regex, matches, self.max_matches)
        elif os.path.isdir(path):
            self._search_dir(path, regex, matches, self.max_matches)
        else:
            raise ValueError(f"grep {path}: not found")

        if len(matches) == 0:
            return "(no matches)"

        result = "\n".join(matches)
        if len(matches) >= self.max_matches:
            result += f"\n... (truncated at {self.max_matches} matches)"

        return result

    def _search_file(self, path: str, regex: re.Pattern, matches: list[str], max_matches: int) -> None:
        """Search a single file."""
        try:
            with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
                for line_no, line in enumerate(f, 1):
                    line = line.rstrip('\r\n')
                    if '\x00' in line:
                        return  # binary file
                    if regex.search(line):
                        matches.append(f"{path}:{line_no}:{line}")
                        # Record query to ledger on first match
                        if self.ledger is not None and len(matches) == 1:
                            self.ledger.record_query(self.name, path)
                        if len(matches) >= max_matches:
                            return
        except Exception:
            pass  # skip unreadable files

    def _search_dir(self, root: str, regex: re.Pattern, matches: list[str], max_matches: int) -> None:
        """Search directory recursively."""
        for dirpath, dirnames, filenames in os.walk(root):
            # Skip hidden and ignored directories
            dirnames[:] = [d for d in dirnames if not self._should_skip_dir(d)]

            for filename in filenames:
                if self._should_skip_file(filename):
                    continue

                filepath = os.path.join(dirpath, filename)
                self._search_file(filepath, regex, matches, max_matches)

                if len(matches) >= max_matches:
                    return

    def _should_skip_dir(self, dirname: str) -> bool:
        """Check if directory should be skipped."""
        return dirname.startswith('.') or dirname in {'node_modules', '__pycache__', 'vendor', 'venv'}

    def _should_skip_file(self, filename: str) -> bool:
        """Check if file should be skipped."""
        return filename.startswith('.')

    def _resolve_in(self, path: str) -> str:
        """Resolve path relative to work_dir."""
        if not self.work_dir:
            return os.path.abspath(path)
        p = Path(path)
        if p.is_absolute():
            return str(p)
        return str(Path(self.work_dir) / p)


@dataclass
class GlobTool:
    """Find files matching a glob pattern."""

    work_dir: str = ""
    ledger: Any = None

    @property
    def name(self) -> str:
        return "glob"

    @property
    def description(self) -> str:
        return "Find files matching a glob pattern (e.g. \"*.go\", \"internal/*/*.go\", \"**/*.test.ts\"). Supports shell metacharacters * ? [] and the recursive ** pattern."

    @property
    def schema(self) -> str:
        return json.dumps({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern (supports ** for recursive matching)"}
            },
            "required": ["pattern"]
        })

    @property
    def read_only(self) -> bool:
        return True

    def execute(self, args: dict[str, Any]) -> str:
        pattern = args.get("pattern", "")
        if not pattern:
            raise ValueError("pattern is required")

        raw_pattern = pattern
        pattern = self._resolve_in(pattern)

        max_results = 1000

        # Check for ** recursive pattern
        if "**" in pattern:
            matches = self._glob_recursive(pattern, max_results)
        else:
            import glob as glob_module
            matches = sorted(glob_module.glob(pattern))

            # If no matches and pattern is simple filename, try recursive
            if len(matches) == 0 and '/' not in raw_pattern and '\\' not in raw_pattern:
                recursive_pattern = os.path.join(self.work_dir if self.work_dir else ".", "**", raw_pattern)
                matches = self._glob_recursive(recursive_pattern, max_results)

        if len(matches) == 0:
            return "(no matches)"

        if len(matches) > max_results:
            matches = matches[:max_results]
            result = "\n".join(matches)
            result += f"\n... (truncated at {max_results} results)"
            return result

        return "\n".join(matches)

    def _glob_recursive(self, pattern: str, max_results: int) -> list[str]:
        """Handle patterns with **."""
        parts = pattern.split("**", 1)
        root = parts[0]

        if not root:
            root = "."

        root = root.rstrip(os.sep)

        if not os.path.isdir(root):
            return []

        suffix = ""
        if len(parts) > 1:
            suffix = parts[1].lstrip(os.sep)

        matches = []

        for dirpath, dirnames, filenames in os.walk(root):
            # Skip hidden and ignored directories
            dirnames[:] = [d for d in dirnames if not d.startswith('.') and d not in {'node_modules', '__pycache__'}]

            for filename in filenames:
                if filename.startswith('.'):
                    continue

                filepath = os.path.join(dirpath, filename)

                if not suffix:
                    matches.append(filepath)
                else:
                    rel_path = os.path.relpath(filepath, root)
                    if self._match_glob_suffix(rel_path, suffix):
                        matches.append(filepath)

                if len(matches) >= max_results:
                    return sorted(matches)

        return sorted(matches)

    def _match_glob_suffix(self, path: str, pattern: str) -> bool:
        """Check if path matches the suffix pattern after **."""
        import fnmatch

        # Direct match
        if fnmatch.fnmatch(path, pattern):
            return True

        # Try matching at each directory level
        parts = path.split(os.sep)
        for i in range(len(parts)):
            sub = os.sep.join(parts[i:])
            if fnmatch.fnmatch(sub, pattern):
                return True

        # Match just filename if pattern has no separator
        if os.sep not in pattern and '/' not in pattern:
            if fnmatch.fnmatch(os.path.basename(path), pattern):
                return True

        return False

    def _resolve_in(self, path: str) -> str:
        """Resolve path relative to work_dir."""
        if not self.work_dir:
            return os.path.abspath(path) if os.path.isabs(path) else path
        p = Path(path)
        if p.is_absolute():
            return str(p)
        return str(Path(self.work_dir) / p)


@dataclass
class LsTool:
    """List directory entries."""

    work_dir: str = ""
    ledger: Any = None

    @property
    def name(self) -> str:
        return "ls"

    @property
    def description(self) -> str:
        return "List the entries of a directory. Directories are shown with a trailing slash; files show their byte size. Set recursive=true to list all nested files depth-first (skips .git/node_modules)."

    @property
    def schema(self) -> str:
        return json.dumps({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path (default \".\")"},
                "recursive": {"type": "boolean", "description": "When true, recursively list all nested files (default false)"}
            }
        })

    @property
    def read_only(self) -> bool:
        return True

    def execute(self, args: dict[str, Any]) -> str:
        path_str = args.get("path", ".")
        if not path_str:
            path_str = "."

        path = self._resolve_in(path_str)
        recursive = args.get("recursive", False)

        if recursive:
            return self._list_recursive(path)

        # Non-recursive listing
        try:
            entries = sorted(os.listdir(path))
        except Exception as e:
            raise ValueError(f"ls {path}: {e}")

        if len(entries) == 0:
            return "(empty directory)"

        result = []
        for entry in entries:
            entry_path = os.path.join(path, entry)
            if os.path.isdir(entry_path):
                result.append(f"{entry}/")
            else:
                try:
                    size = os.path.getsize(entry_path)
                    result.append(f"{entry}\t{size}")
                except Exception:
                    result.append(f"{entry}\t-1")

        return "\n".join(result)

    def _list_recursive(self, root: str) -> list[str]:
        """List directory recursively."""
        result = []

        for dirpath, dirnames, filenames in os.walk(root):
            # Skip hidden and noise directories
            dirnames[:] = [d for d in dirnames if d not in {'.git', 'node_modules', '.DS_Store', '__pycache__', '.idea', '.vscode'}]

            for dirname in dirnames:
                full_path = os.path.join(dirpath, dirname)
                try:
                    rel_path = os.path.relpath(full_path, root)
                    # Guard against excessive depth
                    if rel_path.count(os.sep) > 50:
                        continue
                    rel_path = rel_path.replace(os.sep, '/')
                    result.append(f"{rel_path}/")
                except ValueError:
                    pass

            for filename in filenames:
                full_path = os.path.join(dirpath, filename)
                try:
                    rel_path = os.path.relpath(full_path, root)
                    # Guard against excessive depth
                    if rel_path.count(os.sep) > 50:
                        continue
                    rel_path = rel_path.replace(os.sep, '/')
                    try:
                        size = os.path.getsize(full_path)
                        result.append(f"{rel_path}\t{size}")
                    except Exception:
                        result.append(rel_path)
                except ValueError:
                    pass

        if len(result) == 0:
            return "(empty directory tree)"

        return "\n".join(result)

    def _resolve_in(self, path: str) -> str:
        """Resolve path relative to work_dir."""
        if not self.work_dir:
            return os.path.abspath(path)
        p = Path(path)
        if p.is_absolute():
            return str(p)
        return str(Path(self.work_dir) / p)


# Registry of built-in tools
BUILTIN_TOOLS = {
    "read_file": ReadFileTool,
    "write_file": WriteFileTool,
    "edit_file": EditFileTool,
    "grep": GrepTool,
    "glob": GlobTool,
    "ls": LsTool,
}
