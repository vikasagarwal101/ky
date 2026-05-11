"""sandbox_local_runner.linters - Ruff rule cache, xo linter runner, and discovery functions."""

from __future__ import annotations

import ast
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Tuple

from .constants import DETECTOR_CATALOG, GENERIC_RULES, TYPESCRIPT_RULES, PYTHON_RULES
from .models import Finding, stable_finding_id
from .state import _append_text
from .utils import run_capture


# Cache for ruff rule descriptions
_Ruff_Rule_Descriptions = {}  # Cache for ruff rule descriptions


# DEAD CODE - verify before using
# This function is defined and cached but never called anywhere in the codebase.
def _get_ruff_rule_description(rule: str) -> str:
    """Fetch the ruff rule description. Cached per rule."""
    if rule in _Ruff_Rule_Descriptions:
        return _Ruff_Rule_Descriptions[rule]

    # Try full rule name (RUF007, F401) first, then strip prefix
    for name in (rule, rule.split('.')[-1] if '.' in rule else rule):
        r = run_capture(['ruff', 'rule', name], cwd=None)
        if r and len(r) > 10:
            _Ruff_Rule_Descriptions[rule] = r.strip()
            return r.strip()

    # Fallback: strip prefix and try again
    if '.' in rule:
        stripped = rule.split('.', 1)[-1]
        r = run_capture(['ruff', 'rule', stripped], cwd=None)
        if r and len(r) > 10:
            _Ruff_Rule_Descriptions[rule] = r.strip()
            return r.strip()

    _Ruff_Rule_Descriptions[rule] = f"[{rule}]"
    return _Ruff_Rule_Descriptions[rule]


def run_xo_linter_in_container(container_name: str = 'ky-phase2-dev') -> Tuple[int, List[Dict[str, Any]]]:
    """Run xo linter in Docker container and return parsed results.

    Returns:
        Tuple of (return_code, list of xo warning objects)
        Each warning object has: filePath, messages (list with ruleId, message, line, column, etc.)
    """
    try:
        res = subprocess.run(
            ['docker', 'exec', container_name, 'npx', 'xo'],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=120
        )
        output = (res.stdout or '').strip()

        # If no output or empty, return empty list
        if not output:
            return res.returncode, []

        # Try to parse as JSON first (for newer xo versions)
        try:
            data = json.loads(output)
            if isinstance(data, list):
                return res.returncode, data
        except json.JSONDecodeError:
            pass

        # Parse text output format:
        # file:line:column
        #   ⚠  line:column  message              rule-id
        # OR (for subsequent files with leading whitespace):
        #   file:line:column
        #     ⚠  line:column  message              rule-id
        results: Dict[str, Dict[str, Any]] = {}
        current_file = None

        for line in output.split('\n'):
            line = line.rstrip()
            if not line:
                continue

            # Check if this is a warning line (contains ⚠ symbol)
            if '⚠' in line:
                # Parse warning line: "  ⚠  line:column  message              rule-id"
                stripped = line.strip()
                if stripped.startswith('⚠') and current_file:
                    rest = stripped[1:].strip()
                    parts = rest.split(None, 1)
                    if len(parts) >= 2:
                        line_col = parts[0]
                        message_and_rule = parts[1]

                        # Parse line:column
                        lc_parts = line_col.split(':')
                        line_num = int(lc_parts[0]) if lc_parts[0].isdigit() else 0
                        col_num = int(lc_parts[1]) if len(lc_parts) > 1 and lc_parts[1].isdigit() else 0

                        # Extract rule ID from the end (last word)
                        msg_parts = message_and_rule.rsplit(None, 1)
                        message = msg_parts[0] if len(msg_parts) > 1 else message_and_rule
                        rule_id = msg_parts[1] if len(msg_parts) > 1 else ''

                        results[current_file]['messages'].append({
                            'ruleId': rule_id,
                            'message': message,
                            'line': line_num,
                            'column': col_num,
                            'severity': 1  # warning
                        })
            else:
                # This might be a file path line (with or without leading whitespace)
                # Format: "file:line:column" or "  file:line:column"
                stripped = line.strip()
                # Check if it looks like a file path (contains : and doesn't start with digit)
                if ':' in stripped and not stripped[0].isdigit():
                    # This is likely a file path line
                    parts = stripped.split(':')
                    if len(parts) >= 2:
                        potential_file = parts[0]
                        # Verify it's not a message (file paths don't contain spaces typically)
                        if ' ' not in potential_file:
                            current_file = potential_file
                            if current_file not in results:
                                results[current_file] = {
                                    'filePath': current_file,
                                    'messages': []
                                }

        return res.returncode, list(results.values())

    except subprocess.TimeoutExpired:
        return 1, []
    except Exception:
        return 1, []


def discover_xo_linter_findings(repo_path: Path, log_file: Path) -> List[Finding]:
    """Discover findings from xo linter for TypeScript/JavaScript repos.

    This runs xo linter in a Docker container (for ky repo) or directly on the host
    and converts warnings to findings.
    """
    findings: List[Finding] = []

    # Only run xo for repos that have xo configured (check for xo in package.json or .xorc)
    package_json = repo_path / 'package.json'
    if not package_json.exists():
        return findings

    # Check if xo is configured in this repo
    try:
        pkg = json.loads(package_json.read_text(encoding='utf-8'))
        has_xo = 'xo' in pkg.get('devDependencies', {}) or 'xo' in pkg.get('dependencies', {})
        if not has_xo:
            return findings
    except Exception:
        return findings

    # Determine how to run xo based on repo
    is_ky_repo = 'ky' in str(repo_path).lower()
    if is_ky_repo:
        # Use Docker container for ky repo
        container_name = 'ky-phase2-dev'
        _append_text(log_file, f'xo-discovery: running xo linter in container {container_name}')
        rc, xo_results = run_xo_linter_in_container(container_name)
    else:
        # Try to run xo directly on the host via npx
        _append_text(log_file, 'xo-discovery: running xo linter via npx')
        try:
            res = subprocess.run(
                ['npx', 'xo', '--format=json'],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=120,
                cwd=str(repo_path)
            )
            output = (res.stdout or '').strip()
            if output:
                try:
                    xo_results = json.loads(output)
                    rc = res.returncode
                except json.JSONDecodeError:
                    rc, xo_results = 1, []
            else:
                rc, xo_results = res.returncode, []
        except Exception as e:
            _append_text(log_file, f'xo-discovery: npx xo failed: {e}')
            return findings

    if rc != 0 and not xo_results:
        _append_text(log_file, f'xo-discovery: xo linter failed with rc={rc}')
        return findings

    rule_meta = {entry['rule']: entry for entry in TYPESCRIPT_RULES}

    # Process xo results
    total_warnings = 0
    for result in xo_results:
        file_path = str(result.get('filePath', ''))
        messages = result.get('messages', [])

        for msg in messages:
            rule_id = str(msg.get('ruleId', ''))
            message_text = str(msg.get('message', ''))
            line = int(msg.get('line', 0))
            column = int(msg.get('column', 0))
            severity = int(msg.get('severity', 1))  # 1=warning, 2=error

            # Skip if no rule ID
            if not rule_id:
                continue

            # Map xo rule IDs to our finding rule names
            rule_mapping = {
                'max-lines': 'xo-max-lines',
                'no-warning-comments': 'xo-no-warning-comments',
                'complexity': 'xo-complexity',
            }

            finding_rule = rule_mapping.get(rule_id, f'xo-{rule_id}')

            # Check if this rule is in our catalog
            if finding_rule not in rule_meta:
                # Add a generic entry for unmapped xo rules
                rule_meta[finding_rule] = {
                    'rule': finding_rule,
                    'category': 'lint',
                    'confidence': 0.75,
                    'autofix': False
                }

            meta = rule_meta.get(finding_rule, {})
            confidence = float(meta.get('confidence', 0.75))
            safe_to_autofix = bool(meta.get('autofix', False))

            # Make file path relative to repo
            if file_path.startswith('/app/'):
                relative_path = file_path[5:]  # Remove /app/ prefix
            elif file_path.startswith(str(repo_path)):
                relative_path = str(Path(file_path).relative_to(repo_path))
            else:
                relative_path = file_path

            snippet = f"{message_text} (line {line}, col {column})"

            finding = Finding(
                finding_id=stable_finding_id(str(repo_path), relative_path, line, finding_rule, snippet),
                repo=str(repo_path),
                path=relative_path,
                line=line,
                rule=finding_rule,
                snippet=snippet,
                confidence=confidence,
                quick_win=severity == 1 and safe_to_autofix,
                safe_to_autofix=safe_to_autofix,
            )
            findings.append(finding)
            total_warnings += 1

    _append_text(log_file, f'xo-discovery: found {total_warnings} xo warnings, converted to {len(findings)} findings')

    return findings


def discover_python_linter_findings(repo_path: Path, log_file: Path) -> List[Finding]:
    """Discover issues from Python linter (ruff) for Python repos.

    This runs ruff linter and converts warnings to findings.
    Only works for repos with ruff installed.
    """
    findings: List[Finding] = []

    # Check if ruff is available
    ruff_path = None
    for candidate in ['ruff', '~/.local/bin/ruff', '/home/vikas/.local/bin/ruff']:
        expanded = Path(candidate).expanduser()
        if expanded.exists():
            ruff_path = str(expanded)
            break

    if not ruff_path:
        # Try to find ruff in PATH
        try:
            res = subprocess.run(['which', 'ruff'], capture_output=True, text=True, timeout=5)
            if res.returncode == 0 and res.stdout.strip():
                ruff_path = res.stdout.strip()
        except Exception:
            pass

    if not ruff_path:
        _append_text(log_file, 'python-discovery: ruff not found, skipping')
        return findings

    # Check if this is a Python repo (has .py files)
    py_files = list(repo_path.rglob('*.py'))
    if not py_files:
        return findings

    _append_text(log_file, f'python-discovery: running ruff linter on {len(py_files)} Python files')

    try:
        # Run ruff with selected rules:
        # B=bugbear, E/W=pycodestyle, F=pyflakes, S=bandit/security, C4=comprehensions
        # Use JSON output to get per-instance fix applicability (not just rule-level catalog)
        res = subprocess.run(
            [ruff_path, 'check', str(repo_path), '--select=B,E,W,F,S,C4', '--output-format=json'],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=300,
            cwd=str(repo_path)
        )
        raw = (res.stdout or '').strip()
    except subprocess.TimeoutExpired:
        _append_text(log_file, 'python-discovery: ruff timed out')
        return findings
    except Exception as e:
        _append_text(log_file, f'python-discovery: ruff failed: {e}')
        return findings

    if not raw or raw == 'null' or raw == '[]':
        _append_text(log_file, 'python-discovery: no ruff findings')
        return findings

    rule_meta = {entry['rule']: entry for entry in PYTHON_RULES}
    seen_finding_ids: set[str] = set()

    try:
        ruff_results = json.loads(raw)
    except json.JSONDecodeError:
        _append_text(log_file, f'python-discovery: ruff JSON parse failed, falling back to concise')
        return findings

    for result in ruff_results:
        try:
            code = result.get('code', '')
            rule_name = f'ruff-{code.lower()}'

            if rule_name not in rule_meta:
                continue

            meta = rule_meta[rule_name]
            confidence = float(meta.get('confidence', 0.75))

            # Determine autofix safety from ruff's per-instance fix applicability.
            # This correctly overrides the blanket catalog value:
            # - "safe"      -> ruff will apply safely
            # - "unsafe"    -> ruff marks it unsafe (e.g. migration dict() rewrites)
            # - "generated" -> fix produces generated code, treat as safe
            # - null         -> ruff has no fix for this specific instance
            fix_obj = result.get('fix')
            if fix_obj is not None:
                applicability = fix_obj.get('applicability')
                safe_to_autofix = applicability in ('safe', 'generated')
            else:
                safe_to_autofix = False

            # Hardcoded override: ruff-c408 (dict() → {} rewrite) often reports as
            # safe/autofixable but ruff --fix fails in practice because the rewriting
            # requires surrounding context. Force it to NOT autofix so it routes to
            # the LLM fix engine instead.
            if rule_name == 'ruff-c408':
                safe_to_autofix = False

            # Suppress ruff-c408 findings in Django migration files — these use dict()
            # for runtime model field resolution and must NEVER be rewritten.
            if rule_name == 'ruff-c408':
                file_rel = str(result.get('filename', ''))
                if '/migrations/' in file_rel:
                    continue

            location = result.get('location', {})
            line_num = int(location.get('row', 0))

            file_rel = str(result.get('filename', ''))
            try:
                file_path = str(Path(file_rel).relative_to(repo_path))
            except ValueError:
                file_path = file_rel

            message = result.get('message', '')[:200]

            finding_id = stable_finding_id(
                str(repo_path), file_path, line_num, rule_name, message
            )

            if finding_id in seen_finding_ids:
                continue
            seen_finding_ids.add(finding_id)

            findings.append(Finding(
                finding_id=finding_id,
                repo=str(repo_path),
                path=file_path,
                line=line_num,
                rule=rule_name,
                snippet=message,
                confidence=confidence,
                quick_win=safe_to_autofix,
                safe_to_autofix=safe_to_autofix,
            ))
        except (ValueError, IndexError, TypeError, KeyError):
            continue

    _append_text(log_file, f'python-discovery: found {len(findings)} ruff findings')
    return findings


def discover_typescript_type_findings(repo_path: Path, log_file: Path) -> List[Finding]:
    """Discover type safety issues in TypeScript files.

    Uses TypeScript compiler in strict mode to detect:
    - Explicit `any` usage
    - Missing return type annotations
    - Missing parameter type annotations
    - Untyped imports / modules with missing declarations
    """
    findings: List[Finding] = []
    rule_meta = {entry['rule']: entry for entry in TYPESCRIPT_RULES}

    # Check if this is a TypeScript repo
    ts_config = repo_path / 'tsconfig.json'
    if not ts_config.exists():
        _append_text(log_file, 'type-discovery: no tsconfig.json found, skipping')
        return findings

    # Run TypeScript compiler to check for type issues
    # We look for common type safety patterns in the output
    try:
        # First, try to run tsc with --noEmit to check for type errors
        rc, output = run_capture(
            ['npx', 'tsc', '--noEmit', '--strict', '--pretty', 'false'],
            cwd=repo_path
        )

        # Parse TypeScript compiler output for type issues
        # TypeScript outputs errors in format: file(line,col): error TSxxxx: message
        type_error_pattern = re.compile(
            r'^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$',
            re.MULTILINE
        )

        for match in type_error_pattern.finditer(output):
            file_path, line, col, error_code, message = match.groups()

            # Map TypeScript error codes to our rules
            rule = None
            snippet = message[:200]

            if (
                error_code == 'TS7016'
                or ('could not find a declaration file for module' in message.lower())
                or ('implicitly has an any type' in message.lower() and 'module' in message.lower())
            ):
                rule = 'type-untyped-import'
            elif 'any' in message.lower() or error_code in ['TS7005', 'TS7006']:
                rule = 'type-explicit-any'
            elif 'return type' in message.lower() or error_code == 'TS7010':
                rule = 'type-missing-return'
            elif 'parameter' in message.lower() and 'implicitly' in message.lower():
                rule = 'type-missing-param'

            if rule and rule in rule_meta:
                meta = rule_meta[rule]
                relative_path = file_path.replace(str(repo_path) + '/', '')

                finding = Finding(
                    finding_id=stable_finding_id(str(repo_path), relative_path, int(line), rule, snippet),
                    repo=str(repo_path),
                    path=relative_path,
                    line=int(line),
                    rule=rule,
                    snippet=snippet,
                    confidence=float(meta.get('confidence', 0.7)),
                    quick_win=meta.get('autofix', False),
                    safe_to_autofix=meta.get('autofix', False),
                )
                findings.append(finding)

        _append_text(log_file, f'type-discovery: found {len(findings)} type safety findings')

    except Exception as e:
        _append_text(log_file, f'type-discovery: error running tsc: {e}')

    return findings


def discover_test_coverage_findings(repo_path: Path, log_file: Path) -> List[Finding]:
    """Discover test coverage gaps using coverage reports.

    Uses coverage tools to detect:
    - Uncovered branches
    - Uncovered functions
    - Uncovered lines (for smaller gaps only)
    """
    findings: List[Finding] = []
    rule_meta = {entry['rule']: entry for entry in TYPESCRIPT_RULES}

    # Check for coverage report or run coverage
    coverage_file = repo_path / 'coverage' / 'coverage-final.json'
    lcov_file = repo_path / 'coverage' / 'lcov.info'

    # If no coverage file exists, try to generate one
    if not coverage_file.exists() and not lcov_file.exists():
        _append_text(log_file, 'coverage-discovery: no coverage file found, attempting to generate')
        try:
            # Try nyc/c8 for Node.js projects
            if (repo_path / 'package.json').exists():
                rc, _ = run_capture(
                    ['npx', 'nyc', '--reporter=json', 'npm', 'test'],
                    cwd=repo_path,
                    timeout=120
                )
        except Exception as e:
            _append_text(log_file, f'coverage-discovery: failed to generate coverage: {e}')

    # Parse coverage report
    if coverage_file.exists():
        try:
            import json
            with open(coverage_file) as f:
                coverage_data = json.load(f)

            for file_path, file_coverage in coverage_data.items():
                # Skip node_modules and test files
                if 'node_modules' in file_path or file_path.endswith('.test.ts'):
                    continue

                relative_path = file_path.replace(str(repo_path) + '/', '')

                # Check for uncovered branches
                branches = file_coverage.get('branches', {})
                if branches:
                    for branch_id, hits in branches.items():
                        if hits == 0:
                            line = int(branch_id.split(',')[0]) if ',' in str(branch_id) else 1
                            finding = Finding(
                                finding_id=stable_finding_id(str(repo_path), relative_path, line, 'test-coverage-branch', f'Branch not covered'),
                                repo=str(repo_path),
                                path=relative_path,
                                line=line,
                                rule='test-coverage-branch',
                                snippet='Branch not covered by tests',
                                confidence=0.82,
                                quick_win=True,
                                safe_to_autofix=True,
                            )
                            findings.append(finding)
                            break  # One finding per file to avoid spam

                # Check for uncovered functions
                functions = file_coverage.get('functions', {})
                if functions:
                    for func_name, func_data in functions.items():
                        if isinstance(func_data, dict):
                            hits = func_data.get('hits', 1)
                            line = func_data.get('line', 1)
                        else:
                            hits = func_data
                            line = 1

                        if hits == 0:
                            finding = Finding(
                                finding_id=stable_finding_id(str(repo_path), relative_path, line, 'test-coverage-function', f'Function {func_name} not covered'),
                                repo=str(repo_path),
                                path=relative_path,
                                line=line,
                                rule='test-coverage-function',
                                snippet=f'Function {func_name} not covered by tests',
                                confidence=0.80,
                                quick_win=True,
                                safe_to_autofix=True,
                            )
                            findings.append(finding)
                            break  # One finding per file

                # Check for uncovered lines, but keep it coarse to avoid spam
                statement_map = file_coverage.get('statementMap', {})
                statement_hits = file_coverage.get('s', {})
                if statement_map and statement_hits:
                    for statement_id, hits in statement_hits.items():
                        if hits != 0:
                            continue
                        location = statement_map.get(str(statement_id)) or statement_map.get(statement_id)
                        if not isinstance(location, dict):
                            continue
                        start = location.get('start') if isinstance(location.get('start'), dict) else {}
                        line = int(start.get('line') or 1)
                        finding = Finding(
                            finding_id=stable_finding_id(str(repo_path), relative_path, line, 'test-coverage-line', 'Line not covered'),
                            repo=str(repo_path),
                            path=relative_path,
                            line=line,
                            rule='test-coverage-line',
                            snippet='Line not covered by tests',
                            confidence=0.78,
                            quick_win=False,
                            safe_to_autofix=False,
                        )
                        findings.append(finding)
                        break  # One line-coverage finding per file

            _append_text(log_file, f'coverage-discovery: found {len(findings)} coverage findings')

        except Exception as e:
            _append_text(log_file, f'coverage-discovery: error parsing coverage: {e}')
    else:
        _append_text(log_file, 'coverage-discovery: no coverage data available')

    return findings


# ── New Detectors (2026-05-11) ─────────────────────────────────

def _find_tool(binary: str) -> Optional[str]:
    """Find a tool binary in common locations. Returns full path or None."""
    for candidate in [binary, f'~/.local/bin/{binary}', f'/home/vikas/.local/bin/{binary}',
                      f'/home/vikas/go/bin/{binary}', f'/home/vikas/.npm-global/bin/{binary}']:
        expanded = Path(candidate).expanduser()
        if expanded.exists():
            return str(expanded)
    try:
        res = subprocess.run(['which', binary], capture_output=True, text=True, timeout=5)
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
    return None


def _discover_tool_findings(
    repo_path: Path,
    log_file: Path,
    binary: str,
    args: List[str],
    rule_prefix: str,
    rule_catalog: List[Dict[str, Any]],
    findings_label: str,
    repo_check: Optional[List[str]] = None,
    output_is_json: bool = True,
    parse_fn=None,
    timeout: int = 120,
) -> List[Finding]:
    """Generic tool-based finding discovery."""
    findings: List[Finding] = []
    tool_path = _find_tool(binary)
    if not tool_path:
        _append_text(log_file, f'{findings_label}: {binary} not found, skipping')
        return findings

    if repo_check:
        has_files = False
        for pattern in repo_check:
            if list(repo_path.rglob(pattern)):
                has_files = True
                break
        if not has_files:
            _append_text(log_file, f'{findings_label}: no matching files found, skipping')
            return findings

    _append_text(log_file, f'{findings_label}: running {binary}')

    try:
        res = subprocess.run(
            [tool_path] + args,
            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=timeout, cwd=str(repo_path),
        )
        raw = (res.stdout or '').strip()
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        _append_text(log_file, f'{findings_label}: {binary} failed: {e}')
        return findings
    except Exception as e:
        _append_text(log_file, f'{findings_label}: {binary} error: {e}')
        return findings

    if not raw:
        _append_text(log_file, f'{findings_label}: no output from {binary}')
        return findings

    rule_meta = {entry['rule']: entry for entry in rule_catalog}

    if output_is_json and parse_fn:
        try:
            data = json.loads(raw)
            findings = parse_fn(data, repo_path, rule_prefix, rule_meta)
        except (json.JSONDecodeError, Exception) as e:
            _append_text(log_file, f'{findings_label}: parse error: {e}')
            return findings
    elif output_is_json:
        try:
            data = json.loads(raw)
            findings = _default_json_parse(data, repo_path, rule_prefix, rule_meta)
        except (json.JSONDecodeError, Exception) as e:
            _append_text(log_file, f'{findings_label}: parse error: {e}')
            return findings
    else:
        findings = _default_line_parse(raw, repo_path, rule_prefix, rule_meta)

    _append_text(log_file, f'{findings_label}: found {len(findings)} findings')
    return findings


def _default_json_parse(data, repo_path: Path, rule_prefix: str, rule_meta: dict) -> List[Finding]:
    """Default JSON parser: expects list of {filePath, messages: [{ruleId, message, line, column}]}."""
    from .models import stable_finding_id
    findings: List[Finding] = []
    seen: set = set()
    if isinstance(data, dict):
        results = data.get('results') or data.get('issues', []) or [data]
    elif isinstance(data, list):
        results = data
    else:
        return findings
    for result in results:
        file_path = str(result.get('filePath', result.get('path', result.get('filename', ''))))
        messages = result.get('messages', [])
        if not messages and 'message' in result:
            messages = [result]
        for msg in messages:
            rule_id = str(msg.get('ruleId', msg.get('rule', '')))
            message_text = str(msg.get('message', ''))
            line = int(msg.get('line', msg.get('row', 0)))
            if not rule_id:
                continue
            full_rule = f'{rule_prefix}{rule_id.lower()}'
            if full_rule not in rule_meta:
                rule_meta[full_rule] = {'rule': full_rule, 'category': 'lint', 'confidence': 0.75, 'autofix': False}
            meta = rule_meta[full_rule]
            try:
                relative_path = str(Path(file_path).relative_to(repo_path))
            except (ValueError, Exception):
                relative_path = file_path
            snippet = message_text[:200] if message_text else full_rule
            finding_id = stable_finding_id(str(repo_path), relative_path, line, full_rule, snippet)
            if finding_id in seen:
                continue
            seen.add(finding_id)
            findings.append(Finding(
                finding_id=finding_id, repo=str(repo_path), path=relative_path, line=line,
                rule=full_rule, snippet=snippet,
                confidence=float(meta.get('confidence', 0.75)),
                quick_win=bool(meta.get('autofix', False)),
                safe_to_autofix=bool(meta.get('autofix', False)),
            ))
    return findings


def _default_line_parse(output: str, repo_path: Path, rule_prefix: str, rule_meta: dict) -> List[Finding]:
    """Parse line-based output where each line has file:line:col: message."""
    from .models import stable_finding_id
    findings: List[Finding] = []
    seen: set = set()
    pattern = re.compile(r'^(.+?):(\d+):(\d+):\s*(.+?)(?:\s+\[(.+?)\])?\s*$', re.MULTILINE)
    for match in pattern.finditer(output):
        file_path, line_str, col_str, message, rule_id = match.groups()
        line = int(line_str)
        rule = rule_id if rule_id else 'general'
        full_rule = f'{rule_prefix}{rule}'
        if full_rule not in rule_meta:
            rule_meta[full_rule] = {'rule': full_rule, 'category': 'lint', 'confidence': 0.75, 'autofix': False}
        meta = rule_meta[full_rule]
        try:
            relative_path = str(Path(file_path).relative_to(repo_path))
        except (ValueError, Exception):
            relative_path = file_path
        snippet = (message or full_rule)[:200]
        finding_id = stable_finding_id(str(repo_path), relative_path, line, full_rule, snippet)
        if finding_id in seen:
            continue
        seen.add(finding_id)
        findings.append(Finding(
            finding_id=finding_id, repo=str(repo_path), path=relative_path, line=line,
            rule=full_rule, snippet=snippet,
            confidence=float(meta.get('confidence', 0.75)),
            quick_win=bool(meta.get('autofix', False)),
            safe_to_autofix=bool(meta.get('autofix', False)),
        ))
    return findings


def _parse_eslint_output(data, repo_path: Path, rule_prefix: str, rule_meta: dict) -> List[Finding]:
    """Parse ESLint JSON output format."""
    return _default_json_parse(data, repo_path, rule_prefix, rule_meta)


def _parse_staticcheck_output(data, repo_path: Path, rule_prefix: str, rule_meta: dict) -> List[Finding]:
    """Parse staticcheck JSON output format."""
    from .models import stable_finding_id
    findings: List[Finding] = []
    seen: set = set()
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = data.get('results', data.get('issues', [data]))
    else:
        return findings
    for item in items:
        code = str(item.get('code', ''))
        message_text = str(item.get('message', ''))
        loc = item.get('location', item.get('position', {}))
        file_path = str(loc.get('file', loc.get('filename', '')))
        line = int(loc.get('line', loc.get('row', 0)))
        if not code:
            continue
        code_lower = code.lower()
        full_rule = f'go-staticcheck-{code_lower}'
        if full_rule not in rule_meta:
            if code_lower.startswith('sa'):
                full_rule = 'go-staticcheck-sa'
            elif code_lower.startswith('st'):
                full_rule = 'go-staticcheck-st'
            elif code_lower.startswith('s1'):
                full_rule = 'go-staticcheck-s1000'
        meta = rule_meta.get(full_rule, {'rule': full_rule, 'category': 'bug', 'confidence': 0.85, 'autofix': False})
        try:
            relative_path = str(Path(file_path).relative_to(repo_path))
        except (ValueError, Exception):
            relative_path = file_path
        snippet = (message_text or code)[:200]
        finding_id = stable_finding_id(str(repo_path), relative_path, line, full_rule, snippet)
        if finding_id in seen:
            continue
        seen.add(finding_id)
        findings.append(Finding(
            finding_id=finding_id, repo=str(repo_path), path=relative_path, line=line,
            rule=full_rule, snippet=snippet,
            confidence=float(meta.get('confidence', 0.85)),
            quick_win=bool(meta.get('autofix', False)),
            safe_to_autofix=bool(meta.get('autofix', False)),
        ))
    return findings


def _parse_shellcheck_output(data, repo_path: Path, rule_prefix: str, rule_meta: dict) -> List[Finding]:
    """Parse ShellCheck JSON1 output format."""
    from .models import stable_finding_id
    findings: List[Finding] = []
    seen: set = set()
    comments = data.get('comments', []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
    for comment in comments:
        file_path = str(comment.get('file', ''))
        line = int(comment.get('line', 0))
        code = str(comment.get('code', ''))
        message_text = str(comment.get('message', ''))
        full_rule = f'shellcheck-sc{code}' if code else 'shellcheck-general'
        meta = rule_meta.get(full_rule, {'rule': full_rule, 'category': 'lint', 'confidence': 0.78, 'autofix': False})
        try:
            relative_path = str(Path(file_path).relative_to(repo_path))
        except (ValueError, Exception):
            relative_path = file_path
        snippet = (message_text or code or 'shell issue')[:200]
        finding_id = stable_finding_id(str(repo_path), relative_path, line, full_rule, snippet)
        if finding_id in seen:
            continue
        seen.add(finding_id)
        findings.append(Finding(
            finding_id=finding_id, repo=str(repo_path), path=relative_path, line=line,
            rule=full_rule, snippet=snippet,
            confidence=float(meta.get('confidence', 0.78)),
            quick_win=False, safe_to_autofix=False,
        ))
    return findings


def _parse_hadolint_output(data, repo_path: Path, rule_prefix: str, rule_meta: dict) -> List[Finding]:
    """Parse hadolint JSON output format."""
    from .models import stable_finding_id
    findings: List[Finding] = []
    seen: set = set()
    items = data if isinstance(data, list) else [data]
    for item in items:
        file_path = str(item.get('file', ''))
        line = int(item.get('line', 1))
        code = str(item.get('code', 'general')).upper()
        message_text = str(item.get('message', ''))
        full_rule = f'hadolint-{code.lower()}'
        meta = rule_meta.get(full_rule, {'rule': 'hadolint-general', 'category': 'lint', 'confidence': 0.78, 'autofix': False})
        try:
            relative_path = str(Path(file_path).relative_to(repo_path))
        except (ValueError, Exception):
            relative_path = file_path
        snippet = (message_text or code)[:200]
        finding_id = stable_finding_id(str(repo_path), relative_path, line, full_rule, snippet)
        if finding_id in seen:
            continue
        seen.add(finding_id)
        findings.append(Finding(
            finding_id=finding_id, repo=str(repo_path), path=relative_path, line=line,
            rule=full_rule, snippet=snippet,
            confidence=float(meta.get('confidence', 0.78)),
            quick_win=False, safe_to_autofix=False,
        ))
    return findings


def _parse_markdownlint_output(data, repo_path: Path, rule_prefix: str, rule_meta: dict) -> List[Finding]:
    """Parse markdownlint JSON output format.
    Supports both:
    - Dict format: {"/path/file.md": [{"lineNumber": ..., "ruleNames": [...], ...}]}
    - Array format: [{"fileName": "...", "lineNumber": ..., "ruleNames": [...], ...}]
    """
    from .models import stable_finding_id
    findings: List[Finding] = []
    seen: set = set()

    if isinstance(data, dict):
        # Dict format: file_path -> issues list
        for file_path, issues in data.items():
            if not isinstance(issues, list):
                continue
            for issue in issues:
                _add_mdl_finding(file_path, issue, repo_path, rule_prefix, rule_meta, findings, seen)
    elif isinstance(data, list):
        # Array format: each item has fileName + issue fields directly
        for item in data:
            if not isinstance(item, dict):
                continue
            file_path = str(item.get('fileName', item.get('file', item.get('filePath', ''))))
            _add_mdl_finding(file_path, item, repo_path, rule_prefix, rule_meta, findings, seen)

    return findings


def _add_mdl_finding(file_path, issue, repo_path, rule_prefix, rule_meta, findings, seen):
    """Helper to add a single markdownlint finding."""
    from .models import stable_finding_id
    line = int(issue.get('lineNumber', issue.get('line', 1)))
    rule_names = issue.get('ruleNames', [])
    rule_id = rule_names[0].lower() if rule_names else 'general'
    detail = str(issue.get('errorDetail', ''))
    desc = str(issue.get('ruleDescription', ''))
    full_rule = f'mdl-{rule_id}'
    meta = rule_meta.get(full_rule, {
        'rule': 'mdl-general', 'category': 'style', 'confidence': 0.68, 'autofix': False,
    })
    try:
        relative_path = str(Path(file_path).relative_to(repo_path))
    except (ValueError, Exception):
        relative_path = file_path
    snippet = (detail or desc or rule_id)[:200]
    finding_id = stable_finding_id(str(repo_path), relative_path, line, full_rule, snippet)
    if finding_id in seen:
        return
    seen.add(finding_id)
    findings.append(Finding(
        finding_id=finding_id, repo=str(repo_path), path=relative_path, line=line,
        rule=full_rule, snippet=snippet,
        confidence=float(meta.get('confidence', 0.68)),
        quick_win=False, safe_to_autofix=False,
    ))


def _parse_gitleaks_output(data, repo_path: Path, rule_prefix: str, rule_meta: dict) -> List[Finding]:
    """Parse gitleaks JSON output format."""
    from .models import stable_finding_id
    findings: List[Finding] = []
    seen: set = set()
    items = data if isinstance(data, list) else [data]
    for item in items:
        description = str(item.get('Description', ''))
        file_path = str(item.get('File', item.get('file', '')))
        line = int(item.get('StartLine', item.get('line', item.get('startLine', 0))))
        rule_id_raw = str(item.get('RuleID', item.get('rule_id', item.get('rule', '')))).lower()
        match = str(item.get('Match', item.get('match', '')))
        rule_mapping = {
            'aws': 'secret-aws-key', 'github': 'secret-github-token',
            'generic-api-key': 'secret-generic-api-key',
            'private-key': 'secret-private-key', 'ssh-private-key': 'secret-private-key',
            'high-entropy': 'secret-high-entropy-string',
        }
        full_rule = 'secret-generic-api-key'
        for key, mapped in rule_mapping.items():
            if key in rule_id_raw:
                full_rule = mapped
                break
        meta = rule_meta.get(full_rule, {'rule': full_rule, 'category': 'secret', 'confidence': 0.95, 'autofix': False})
        try:
            relative_path = str(Path(file_path).relative_to(repo_path))
        except (ValueError, Exception):
            relative_path = file_path
        snippet = (description or match or 'potential secret')[0:200]
        finding_id = stable_finding_id(str(repo_path), relative_path, line, full_rule, snippet)
        if finding_id in seen:
            continue
        seen.add(finding_id)
        findings.append(Finding(
            finding_id=finding_id, repo=str(repo_path), path=relative_path, line=line,
            rule=full_rule, snippet=snippet,
            confidence=float(meta.get('confidence', 0.95)),
            quick_win=False, safe_to_autofix=False,
        ))
    return findings


def discover_eslint_findings(repo_path: Path, log_file: Path) -> List[Finding]:
    """Discover findings from ESLint for JavaScript/TypeScript repos."""
    # Check for eslint config before running — ESLint crashes without one
    eslint_configs = [
        '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yaml',
        '.eslintrc.yml', '.eslintrc.json', '.eslintrc.mjs',
    ]
    has_config = any((repo_path / cfg).exists() for cfg in eslint_configs)
    # Also check for eslintConfig in package.json
    if not has_config:
        pkg = repo_path / 'package.json'
        if pkg.exists():
            try:
                pkg_data = json.loads(pkg.read_text())
                if pkg_data.get('eslintConfig'):
                    has_config = True
            except Exception:
                pass

    if not has_config:
        _append_text(log_file, 'eslint-discovery: no eslint config found, skipping')
        return []

    return _discover_tool_findings(
        repo_path, log_file, binary='eslint',
        args=['--format=json', '.'],
        rule_prefix='eslint-', rule_catalog=[],
        findings_label='eslint-discovery',
        repo_check=['*.js', '*.jsx', '*.ts', '*.tsx', '*.mjs', '*.cjs'],
        parse_fn=_parse_eslint_output, timeout=180,
    )


def discover_staticcheck_findings(repo_path: Path, log_file: Path) -> List[Finding]:
    """Discover findings from staticcheck for Go repos."""
    from .constants import GO_RULES
    return _discover_tool_findings(
        repo_path, log_file, binary='staticcheck',
        args=['-f', 'json', './...'],
        rule_prefix='go-', rule_catalog=GO_RULES,
        findings_label='staticcheck-discovery',
        repo_check=['*.go'],
        parse_fn=_parse_staticcheck_output, timeout=180,
    )


def discover_shellcheck_findings(repo_path: Path, log_file: Path) -> List[Finding]:
    """Discover findings from ShellCheck for shell/bash scripts."""
    from .constants import SHELL_RULES

    # Find all shell files recursively
    shell_files = []
    for pattern in ('*.sh', '*.bash', '*.ksh'):
        shell_files.extend(repo_path.rglob(pattern))
    shell_files = [f for f in shell_files if f.is_file() and not any(
        p.name in ('node_modules', '.git', '__pycache__') for p in f.parents
    )]

    if not shell_files:
        _append_text(log_file, 'shellcheck-discovery: no shell scripts found, skipping')
        return []

    _append_text(log_file, f'shellcheck-discovery: running shellcheck on {len(shell_files)} files')

    return _discover_tool_findings(
        repo_path, log_file, binary='shellcheck',
        args=['--format=json1', '--shell=bash', '--severity=style']
            + [str(f.relative_to(repo_path)) for f in shell_files],
        rule_prefix='shellcheck-', rule_catalog=SHELL_RULES,
        findings_label='shellcheck-discovery',
        parse_fn=_parse_shellcheck_output, timeout=180,
    )


def discover_hadolint_findings(repo_path: Path, log_file: Path) -> List[Finding]:
    """Discover findings from hadolint for Dockerfiles."""
    from .constants import DOCKER_RULES

    # Expand glob in Python since subprocess doesn't handle ** globs
    dockerfiles = sorted(repo_path.rglob('Dockerfile*'))
    dockerfiles = [f for f in dockerfiles if f.is_file() and not any(
        p.name in ('node_modules', '.git', '__pycache__') for p in f.parents
    )]

    if not dockerfiles:
        _append_text(log_file, 'hadolint-discovery: no Dockerfiles found, skipping')
        return []

    _append_text(log_file, f'hadolint-discovery: found {len(dockerfiles)} Dockerfile(s), running hadolint')

    return _discover_tool_findings(
        repo_path, log_file, binary='hadolint',
        args=['--format', 'json'] + [str(f.relative_to(repo_path)) for f in dockerfiles],
        rule_prefix='hadolint-', rule_catalog=DOCKER_RULES,
        findings_label='hadolint-discovery',
        parse_fn=_parse_hadolint_output, timeout=60,
    )


def discover_markdownlint_findings(repo_path: Path, log_file: Path) -> List[Finding]:
    """Discover findings from markdownlint for Markdown files."""
    from .constants import MARKDOWN_RULES

    md_files = sorted(repo_path.rglob('*.md'))
    md_files = [f for f in md_files if f.is_file() and not any(
        p.name in ('node_modules', '.git', '__pycache__') for p in f.parents
    )]

    if not md_files:
        _append_text(log_file, 'markdownlint-discovery: no markdown files found, skipping')
        return []

    _append_text(log_file, f'markdownlint-discovery: running markdownlint on {len(md_files)} files')

    return _discover_tool_findings(
        repo_path, log_file, binary='markdownlint',
        args=['--json'] + [str(f.relative_to(repo_path)) for f in md_files],
        rule_prefix='mdl-', rule_catalog=MARKDOWN_RULES,
        findings_label='markdownlint-discovery',
        parse_fn=_parse_markdownlint_output, timeout=120,
    )


def discover_actionlint_findings(repo_path: Path, log_file: Path) -> List[Finding]:
    """Discover findings from actionlint for GitHub Actions workflows."""
    from .constants import ACTIONS_RULES
    return _discover_tool_findings(
        repo_path, log_file, binary='actionlint',
        args=['-no-color'],
        rule_prefix='actionlint-', rule_catalog=ACTIONS_RULES,
        findings_label='actionlint-discovery',
        repo_check=['.github/workflows/*.yml'],
        output_is_json=False, timeout=60,
    )


def discover_gitleaks_findings(repo_path: Path, log_file: Path) -> List[Finding]:
    """Discover secrets using gitleaks."""
    from .constants import SECRET_RULES
    import tempfile
    import os

    findings: List[Finding] = []
    tool_path = _find_tool('gitleaks')
    if not tool_path:
        _append_text(log_file, 'gitleaks-discovery: gitleaks not found, skipping')
        return findings

    _append_text(log_file, 'gitleaks-discovery: running gitleaks')

    # Gitleaks writes the report to --report-path; stdout contains banner + info lines
    tmp_report = Path(tempfile.mktemp(suffix='.json'))
    try:
        res = subprocess.run(
            [tool_path, 'detect', '--no-git', '--source', str(repo_path),
             '--report-format', 'json', '--report-path', str(tmp_report)],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=120, cwd=str(repo_path),
        )
        if tmp_report.exists() and tmp_report.stat().st_size > 0:
            raw = tmp_report.read_text().strip()
        else:
            raw = ''
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        _append_text(log_file, f'gitleaks-discovery: gitleaks failed: {e}')
        return findings
    except Exception as e:
        _append_text(log_file, f'gitleaks-discovery: gitleaks error: {e}')
        return findings
    finally:
        try:
            tmp_report.unlink(missing_ok=True)
        except Exception:
            pass

    if not raw or raw == 'null' or raw == '[]':
        _append_text(log_file, 'gitleaks-discovery: no secrets found')
        return findings

    rule_meta = {entry['rule']: entry for entry in SECRET_RULES}
    try:
        data = json.loads(raw)
        findings = _parse_gitleaks_output(data, repo_path, 'secret-', rule_meta)
    except (json.JSONDecodeError, Exception) as e:
        _append_text(log_file, f'gitleaks-discovery: parse error: {e}')
        return findings

    _append_text(log_file, f'gitleaks-discovery: found {len(findings)} secrets')
    return findings
