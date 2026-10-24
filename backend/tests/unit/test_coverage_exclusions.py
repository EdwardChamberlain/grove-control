"""Coverage exclusions must be rare, narrow and explained.

Excluding code from coverage hides it from the CI floors, so the rules in
CLAUDE.md ("Coverage exclusions") are enforced here:

- Only code that cannot run in the test environment may be excluded.
- Exclusions mark lines or blocks, never whole files or patterns.
- Every exclusion states its reason on the same line.
"""

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
BACKEND_APP = REPO_ROOT / "backend" / "app"
COVERAGERC = REPO_ROOT / "backend" / ".coveragerc"
FRONTEND_SRC = REPO_ROOT / "frontend" / "src"
VITEST_CONFIG = REPO_ROOT / "frontend" / "vitest.config.ts"

# A reason has to say why the code cannot run, so one-word labels such as
# "defensive" are rejected.
MIN_REASON_WORDS = 4

PY_PRAGMA = re.compile(r"pragma:\s*no\s*cover", re.IGNORECASE)
PY_PRAGMA_WITH_REASON = re.compile(r"#\s*pragma: no cover - (?P<reason>.+)$")

# Hint comments Vitest's v8 provider honours, e.g. /* v8 ignore next -- reason */
TS_HINT = re.compile(r"\b(?:istanbul|[cv]8|node:coverage)\s+ignore\b", re.IGNORECASE)
TS_HINT_FILE = re.compile(r"\b(?:istanbul|[cv]8|node:coverage)\s+ignore\s+file\b", re.IGNORECASE)
TS_HINT_WITH_REASON = re.compile(
    r"(?:/\*|//)\s*(?:istanbul|[cv]8|node:coverage) ignore (?:next|if|else|start|stop)\b"
    r"[^*]*?--\s*(?P<reason>[^*]+?)\s*(?:\*/|$)"
)

# Whole-file exclusions in vitest.config.ts. Each is allowed for the reason
# given; adding to this list needs the same justification in review.
ALLOWED_VITEST_EXCLUDES = {
    "src/**/*.test.{ts,tsx}": "test files",
    "src/**/*.spec.{ts,tsx}": "test files",
    "src/__tests__/**": "test helpers and setup",
    "src/main.tsx": "entry point that only mounts <App /> into the real DOM",
    "src/vite-env.d.ts": "type declarations, no runtime code",
}


def _reason_problem(reason: str | None) -> str | None:
    if reason is None:
        return "no reason given"
    reason = reason.strip()
    if reason.startswith("@preserve"):
        reason = reason[len("@preserve") :].strip()
    if len(reason.split()) < MIN_REASON_WORDS:
        return f"reason too short ({reason!r}); say why this cannot run in tests"
    return None


def _backend_exclusions():
    for path in sorted(BACKEND_APP.rglob("*.py")):
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if PY_PRAGMA.search(line):
                yield path, lineno, line


def _frontend_exclusions():
    for path in sorted(FRONTEND_SRC.rglob("*.ts*")):
        if path.suffix not in {".ts", ".tsx"} or "__tests__" in path.parts:
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if TS_HINT.search(line):
                yield path, lineno, line


class TestBackendExclusions:
    def test_every_pragma_states_a_reason(self):
        problems = []
        for path, lineno, line in _backend_exclusions():
            match = PY_PRAGMA_WITH_REASON.search(line)
            problem = _reason_problem(match["reason"] if match else None)
            if problem:
                problems.append(f"{path.relative_to(REPO_ROOT)}:{lineno}: {problem}")
        if problems:
            pytest.fail(
                "Coverage exclusions need a reason on the same line, written as\n"
                "  # pragma: no cover - <why this cannot run in tests>\n\n" + "\n".join(problems)
            )

    def test_coveragerc_has_no_file_or_pattern_exclusions(self):
        # omit drops whole files; exclude_lines / exclude_also exclude every
        # line matching a pattern. Both hide code without a per-line reason.
        text = COVERAGERC.read_text(encoding="utf-8")
        found = re.findall(r"^\s*(omit|exclude_lines|exclude_also|partial_branches)\s*=", text, re.MULTILINE)
        assert not found, f"backend/.coveragerc must not use {found}; mark individual lines instead"


@pytest.mark.skipif(
    not FRONTEND_SRC.exists(),
    reason="frontend sources not present (e.g. backend-only Docker test image)",
)
class TestFrontendExclusions:
    def test_every_ignore_hint_states_a_reason(self):
        problems = []
        for path, lineno, line in _frontend_exclusions():
            if TS_HINT_FILE.search(line):
                problem = "whole-file exclusions are not allowed"
            else:
                match = TS_HINT_WITH_REASON.search(line)
                problem = _reason_problem(match["reason"] if match else None)
            if problem:
                problems.append(f"{path.relative_to(REPO_ROOT)}:{lineno}: {problem}")
        if problems:
            pytest.fail(
                "Coverage exclusions need a reason in the hint comment, written as\n"
                "  /* v8 ignore next -- <why this cannot run in tests> */\n\n" + "\n".join(problems)
            )

    def test_vitest_config_excludes_only_known_files(self):
        text = VITEST_CONFIG.read_text(encoding="utf-8")
        coverage_block = text[text.index("coverage:") :]
        exclude_list = re.search(r"exclude:\s*\[(?P<items>[^\]]*)\]", coverage_block)
        assert exclude_list, "could not find coverage.exclude in frontend/vitest.config.ts"
        excludes = set(re.findall(r"['\"]([^'\"]+)['\"]", exclude_list["items"]))
        unexpected = excludes - ALLOWED_VITEST_EXCLUDES.keys()
        assert not unexpected, (
            f"New whole-file coverage exclusions in vitest.config.ts: {sorted(unexpected)}. "
            "Mark individual lines with a reason instead (see CLAUDE.md)."
        )


class TestReasonCheck:
    """The checks above reject what they should."""

    @pytest.mark.parametrize(
        "line",
        [
            "except Exception:  # pragma: no cover",
            "except Exception:  # pragma: no cover - defensive",
            "except Exception:  # pragma: no cover — em dash not accepted",
        ],
    )
    def test_rejects_python_pragmas_without_a_reason(self, line):
        match = PY_PRAGMA_WITH_REASON.search(line)
        assert _reason_problem(match["reason"] if match else None)

    def test_accepts_python_pragma_with_a_reason(self):
        line = "except AttributeError:  # pragma: no cover - unreachable on Python 3.11+, which the app requires"
        match = PY_PRAGMA_WITH_REASON.search(line)
        assert match and _reason_problem(match["reason"]) is None

    @pytest.mark.parametrize(
        "line",
        [
            "/* v8 ignore next */",
            "/* v8 ignore next -- @preserve */",
            "/* istanbul ignore next -- hard */",
        ],
    )
    def test_rejects_ts_hints_without_a_reason(self, line):
        match = TS_HINT_WITH_REASON.search(line)
        assert _reason_problem(match["reason"] if match else None)

    def test_detects_whole_file_ts_hints(self):
        assert TS_HINT_FILE.search("/* v8 ignore file -- @preserve the whole viewer needs WebGL */")

    def test_accepts_ts_hint_with_a_reason(self):
        line = "/* v8 ignore next -- @preserve jsdom has no WebGL context to create */"
        match = TS_HINT_WITH_REASON.search(line)
        assert match and _reason_problem(match["reason"]) is None
