"""授权等待表（对照 Java 版 `AgentApprovalRegistry`）。

写工具在 agent 循环里**发一条授权请求就挂起等待**用户的答复，答复从另一个请求
（`POST /ai/agent/approvals`）进来，这里把两边接上。这样「助手发起工具调用 → 用户批准 →
工具真正执行 → 结果写回工具结果」全在**同一条对话流**里走完。

**等待不占线程**：交出去的是 `asyncio.Future`，`await` 它只会把当前协程挂起，
事件循环照常跑别的请求——不像「阻塞式轮询」那样把一根线程按在那里。

四种收尾都必须让等待结束并清掉登记：
用户点了允许 / 拒绝（`resolve`）、超时（`call_later`）、客户端断开（`cancel`）。
留一条在表里，就意味着有人的对话挂在那里没人应答；漏一次「拒绝」，就可能把用户没答应的
东西写进日历——所以这里宁可一律按拒绝走。
"""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)

DENIED = {"allow": False, "feedback": ""}

_waiting: dict[str, tuple[int, asyncio.Future]] = {}


def register(account_id: int, action_id: str, timeout: float) -> asyncio.Future:
    """登记一次等待，返回 future。

    超时是**正常完成**（值是拒绝），不是异常——调用方不需要处理 TimeoutError。
    """
    loop = asyncio.get_running_loop()
    future: asyncio.Future = loop.create_future()
    _waiting[action_id] = (account_id, future)
    timer = loop.call_later(timeout, _deny, action_id)

    def _cleanup(_: asyncio.Future) -> None:
        timer.cancel()
        _waiting.pop(action_id, None)

    future.add_done_callback(_cleanup)
    return future


def _deny(action_id: str) -> None:
    entry = _waiting.get(action_id)
    if entry is not None and not entry[1].done():
        logger.info("等待授权超时，按拒绝处理：%s", action_id)
        entry[1].set_result(dict(DENIED))


def resolve(account_id: int, action_id: str, allow: bool, feedback: str | None) -> bool:
    """用户点了允许 / 拒绝。账号对不上或已经超时就不算数（返回 False，客户端不必重试）。"""
    entry = _waiting.get(action_id)
    if entry is None or entry[0] != account_id:
        return False
    _waiting.pop(action_id, None)
    if entry[1].done():
        return False
    entry[1].set_result({"allow": bool(allow), "feedback": feedback or ""})
    return True


def cancel(action_id: str) -> None:
    """客户端断开 / 用户点了停止：不会有人再答复了，立刻按拒绝收尾。"""
    entry = _waiting.pop(action_id, None)
    if entry is not None and not entry[1].done():
        logger.info("客户端已断开，这次授权按拒绝收尾：%s", action_id)
        entry[1].set_result(dict(DENIED))


def pending_action_ids() -> set[str]:
    """当前正在等用户答复的授权 id（排查与测试用）。"""
    return set(_waiting)
