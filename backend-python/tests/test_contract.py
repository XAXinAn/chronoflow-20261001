"""跨语言契约校验（Python 侧）。

与 Java 版 `OpenApiContractTest` 读取**同一份** `contract/api-contract.json`。
完整对齐要等 Python 版补齐全部模块；当前先保证：
已实现的接口不超出契约、鉴权声明与契约一致、覆盖率不倒退。
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT = json.loads((REPO_ROOT / "contract" / "api-contract.json").read_text(encoding="utf-8"))
HTTP_METHODS = {"get", "post", "put", "patch", "delete"}

# 覆盖率棘轮：Python 版已实现全部契约端点，不允许倒退
MIN_COVERAGE_PERCENT = 100


def _contract_index() -> dict[tuple[str, str], dict]:
    return {(item["method"], item["path"]): item for item in CONTRACT["endpoints"]}


def _implemented() -> dict[tuple[str, str], dict]:
    from app.main import app

    spec = app.openapi()
    result: dict[tuple[str, str], dict] = {}
    for path, item in spec["paths"].items():
        for method, operation in item.items():
            if method in HTTP_METHODS:
                result[(method.upper(), path)] = operation
    return result


def test_implemented_endpoints_are_declared_in_contract() -> None:
    contract = _contract_index()
    undeclared = sorted(
        f"{method} {path}" for method, path in _implemented() if (method, path) not in contract
    )
    assert not undeclared, f"以下接口未在共享契约中声明：{undeclared}"


def test_security_declaration_matches_contract() -> None:
    contract = _contract_index()
    mismatched: list[str] = []
    for (method, path), operation in _implemented().items():
        declared = bool(operation.get("security"))
        expected = contract[(method, path)]["auth"] == "access"
        if declared != expected:
            mismatched.append(f"{method} {path}（契约要求与实现的安全声明不一致）")
    assert not mismatched, "\n".join(mismatched)


def test_contract_coverage_does_not_regress() -> None:
    total = len(CONTRACT["endpoints"])
    implemented = len(_implemented())
    percent = implemented * 100 / total
    assert percent >= MIN_COVERAGE_PERCENT, (
        f"Python 版对共享契约的覆盖率降到 {percent:.1f}%（{implemented}/{total}），"
        f"低于棘轮下限 {MIN_COVERAGE_PERCENT}%"
    )


def test_envelope_shape_is_declared() -> None:
    assert set(CONTRACT["envelope"]) == {"code", "message", "data", "traceId"}
