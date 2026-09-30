"""「小安」的对话编排（spec §11 阶段三，对照 Java 版 `AgentChatService`）。

四条不变量：
1. **一次对话 = 一个循环**：模型 → 工具调用 → 执行 → 把结果写回 → 再问模型，直到模型不再调工具；
2. **工具在服务端执行**：读工具直接查，写工具走权限层（用户点了允许才真正落库，
   走的是与 REST 完全同一套 Service）；
3. **权限是等待，但不占线程**：写工具发一条授权请求就 `await` 一个 future 等用户答复
   （另一个请求进来 resolve）。挂起的是**协程**，不是线程——不像 Java 那版早期
   用 200ms 轮询阻塞着等；
4. **历史里 tool_use 与 tool_result 永远配对**（mewcode `conversation/ToolPairing`）：
   客户端把工具调用与结果一起带回来，服务端发请求前再修一遍配对。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from ..config import settings
from ..errors import ApiError, ErrorCode
from . import agent_approvals, agent_model, agent_prompt, agent_tools, agent_write

logger = logging.getLogger(__name__)

# 整条流的超时。要盖得住「等用户点授权」那段（与 Java 版同一量级）
STREAM_TIMEOUT = 5 * 60.0
# 等用户答复授权的上限：面板就摆在输入框的位置，正常几秒就点了
APPROVAL_TIMEOUT = 90.0

ROLE_SYSTEM = "system"
ROLE_USER = "user"
ROLE_ASSISTANT = "assistant"
ROLE_TOOL = "tool"

# 用户拒绝时写回模型的工具结果（mewcode `ToolPairing.REJECTED_TOOL_RESULT` 的中文版）
REJECTED_TOOL_RESULT = (
    "用户拒绝了这次操作，什么都没有改动。不要再重新申请同一个动作，"
    "可以用一句话说明，或者问用户要不要换个做法。"
)

NUDGE = """系统提醒：用户这句话是要创建 / 修改 / 删除日程的意思，但你只回了一段文字，还没走到申请授权。
（如果用户其实只是查询，忽略这条提醒，直接回答就好。）
真要写就必须调用工具：需要 id 时先用 list_my_events 找到那条日程，
找到之后**立刻**调用 create_my_event / update_my_event / delete_my_event 申请授权——
不要用一句「确认一下？」代替授权请求。只回复文字的话，
用户面前没有可点的授权行，这件事等于没发生。
你刚才那段文字已经显示给用户了，**不要再重复它**，直接调工具。"""

# 明确的写动词
WRITE_VERBS = (
    "建", "创建", "新建", "加个", "加一", "记一下", "记录一下", "提醒我",
    "改", "改成", "改为", "调整", "推迟", "提前", "延长",
    "删", "删除", "取消", "去掉",
)
# 事情本身的味道（"安排"既可能是查询也可能是写操作，所以只进宽口径）
EVENT_MARKERS = (
    "安排", "开会", "会议", "聚餐", "面试", "出差", "约会", "体检", "值班", "接机", "送机",
)
TIME_MARKERS = (
    "今天", "明天", "后天", "今晚", "今早", "上午", "下午", "晚上", "中午",
    "周一", "周二", "周三", "周四", "周五", "周六", "周日", "周天",
    "下周", "这周", "本月", "下个月", "次月", "点钟",
)

_END = object()


@dataclass
class _Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0

    def add(self, result) -> None:
        self.prompt_tokens += int(getattr(result, "prompt_tokens", 0) or 0)
        self.completion_tokens += int(getattr(result, "completion_tokens", 0) or 0)

    def payload(self) -> dict:
        return {"promptTokens": self.prompt_tokens, "completionTokens": self.completion_tokens}


async def events(scope, turns):
    """把一次对话变成一个 SSE 事件流：`(事件名, payload)` 的异步生成器。

    事件名与 Java 版一字不差：status / delta / tool / action / done / error。
    """
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()
    abort = _AbortFlag()

    def push(name: str, payload: dict) -> None:
        # `_END` 是"这条流说完了"的哨兵，不带 payload
        loop.call_soon_threadsafe(queue.put_nowait, _END if name is _END else (name, payload))

    task = asyncio.create_task(_drive(scope, turns, push, abort))
    deadline = time.monotonic() + STREAM_TIMEOUT
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                yield "error", {"code": int(ErrorCode.THIRD_PARTY_UNAVAILABLE),
                                "message": "助手响应超时，请稍后再试"}
                return
            try:
                item = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                yield "error", {"code": int(ErrorCode.THIRD_PARTY_UNAVAILABLE),
                                "message": "助手响应超时，请稍后再试"}
                return
            if item is _END:
                return
            yield item
    finally:
        # 客户端断开 / 生成器被关掉：停手，别让上游继续跑、也别把挂着的授权留在表里
        abort.set()
        if not task.done():
            task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


class _AbortFlag:
    """跨线程的「停手」信号：模型调用跑在 `to_thread` 里，得由它来打断。"""

    def __init__(self) -> None:
        self._set = False

    def set(self) -> None:
        self._set = True

    @property
    def is_set(self) -> bool:
        return self._set


async def _drive(scope, turns, push, abort: _AbortFlag) -> None:
    started = time.monotonic()
    usage = _Usage()
    rounds = 0
    finish_reason = "stop"
    zone = ZoneInfo(settings.agent_timezone)
    now = datetime.now(zone)
    model = agent_model.client()
    user_text = _last_user_text(turns)
    try:
        conversation = _build_conversation(scope, turns, zone, now)
        tool_calls = 0
        write_attempts = 0
        nudges = 0
        action_seq = 0

        while True:
            if rounds >= settings.agent_max_tool_rounds:
                push("done", {"finishReason": finish_reason, "usage": usage.payload()})
                return
            rounds += 1

            def on_delta(piece: str) -> None:
                if abort.is_set:
                    raise agent_model.AgentStreamAborted("客户端已断开")
                push("delta", {"text": piece})

            # 上游是阻塞式读 SSE，扔进线程里跑，别把事件循环按住
            result = await asyncio.to_thread(
                model.complete, conversation, agent_tools.specs(), on_delta
            )
            usage.add(result)
            if result.finish_reason:
                finish_reason = result.finish_reason

            if not result.tool_calls:
                # 兜底追问：只在还没碰过写操作时催（详见 NUDGE 与 _looks_like_write_intent）
                write_intent = (
                    write_attempts == 0
                    and nudges == 0
                    and (
                        _looks_like_write_intent(user_text) if tool_calls == 0
                        else _has_write_verb(user_text)
                    )
                )
                if write_intent:
                    nudges += 1
                    conversation.append({"role": ROLE_SYSTEM, "content": NUDGE})
                    continue
                push("done", {"finishReason": finish_reason, "usage": usage.payload()})
                return

            conversation.append({
                "role": ROLE_ASSISTANT,
                "content": result.text or "",
                "tool_calls": [
                    {
                        "id": call["id"],
                        "type": "function",
                        "function": {"name": call["name"],
                                     "arguments": call["arguments"] or "{}"},
                    }
                    for call in result.tool_calls
                ],
            })

            for call in result.tool_calls:
                tool_calls += 1
                if agent_tools.is_read_only(call["name"]):
                    push("status", _status_of(call["name"]))
                    outcome = await asyncio.to_thread(
                        agent_tools.invoke, scope, call, None, now, zone
                    )
                    push("tool", _tool_event(call, outcome))
                    conversation.append({"role": ROLE_TOOL, "tool_call_id": call["id"],
                                         "content": outcome.json})
                    continue

                write_attempts += 1
                action_seq += 1
                action_id = _new_action_id(action_seq)
                # 权限层：先把这次写操作摆给用户看，再等他答复
                ask = await asyncio.to_thread(
                    agent_tools.invoke, scope, call, action_id, now, zone
                )
                if ask.action is None:
                    # 参数不全 / 找不到那条日程：把错误交回模型，它会解释或改法
                    push("tool", _tool_event(call, ask))
                    conversation.append({"role": ROLE_TOOL, "tool_call_id": call["id"],
                                         "content": ask.json})
                    continue

                push("status", _status_of(call["name"]))
                push("action", ask.action)
                decision = await _wait_approval(scope.account_id, action_id)

                if not decision.get("allow"):
                    rejected = REJECTED_TOOL_RESULT + (
                        f" 用户补充说：{decision['feedback']}" if decision.get("feedback") else ""
                    )
                    push("tool", {
                        "toolCallId": call["id"], "name": call["name"],
                        "arguments": call.get("arguments"), "result": rejected,
                        "readOnly": False, "summary": "已拒绝",
                        "detail": [ask.action["summary"]],
                    })
                    conversation.append({"role": ROLE_TOOL, "tool_call_id": call["id"],
                                         "content": rejected})
                    continue

                # 允许 → 真正执行（与 REST 同一套 Service）
                written = await asyncio.to_thread(
                    agent_write.execute, scope.personal_identity_id, ask.action, zone
                )
                push("tool", {
                    "toolCallId": call["id"], "name": call["name"],
                    "arguments": call.get("arguments"), "result": written.json,
                    "readOnly": False, "summary": written.summary,
                    "detail": [written.summary],
                })
                conversation.append({"role": ROLE_TOOL, "tool_call_id": call["id"],
                                     "content": written.json})
    except agent_model.AgentStreamAborted:
        # 客户端已经走了：什么都不用发，让它安静收尾
        pass
    except asyncio.CancelledError:
        raise
    except ApiError as ex:
        push("error", {"code": int(ex.code), "message": ex.message})
    except Exception:  # noqa: BLE001 —— 兜底：任何意外都要变成一条 error 事件，而不是断流
        logger.exception("助手对话失败")
        push("error", {"code": int(ErrorCode.INTERNAL_ERROR),
                       "message": "助手暂时不可用，请稍后再试"})
    finally:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        logger.info(
            "agent chat: prompt=%s, provider=%s, rounds=%s, promptTokens=%s,"
            " completionTokens=%s, elapsedMs=%s",
            agent_prompt.version(), model.provider_name(), rounds,
            usage.prompt_tokens, usage.completion_tokens, elapsed_ms,
        )
        push(_END, {})


async def _wait_approval(account_id: int, action_id: str) -> dict:
    future = agent_approvals.register(account_id, action_id, APPROVAL_TIMEOUT)
    try:
        return await future
    except asyncio.CancelledError:
        # 客户端断开 / 整条流被取消：不会有人再答复了，立刻按拒绝收尾
        agent_approvals.cancel(action_id)
        raise


# --------------------------------------------------------------- 上下文组装


def _build_conversation(scope, turns, zone: ZoneInfo, now: datetime) -> list[dict]:
    conversation: list[dict] = [{"role": ROLE_SYSTEM,
                                 "content": _system_prompt(scope, zone, now)}]
    kept = _keep_recent_turns(turns or [], settings.agent_max_history_messages)
    for turn in kept:
        if not isinstance(turn, dict):
            continue
        role = (turn.get("role") or ROLE_USER).lower()
        content = turn.get("content")
        if role == ROLE_ASSISTANT:
            calls = []
            for call in turn.get("toolCalls") or []:
                if isinstance(call, dict) and call.get("name"):
                    calls.append({
                        "id": call.get("id"),
                        "type": "function",
                        "function": {"name": call["name"],
                                     "arguments": call.get("arguments") or "{}"},
                    })
            if not calls and not (content or "").strip():
                continue
            message: dict = {"role": ROLE_ASSISTANT, "content": content or ""}
            if calls:
                message["tool_calls"] = calls
            conversation.append(message)
        elif role == ROLE_TOOL:
            if turn.get("toolCallId"):
                conversation.append({"role": ROLE_TOOL, "tool_call_id": turn["toolCallId"],
                                     "content": content or ""})
        elif (content or "").strip():
            conversation.append({"role": ROLE_USER, "content": content})
    return _repair_pairs(conversation)


def _keep_recent_turns(turns: list[dict], keep: int) -> list[dict]:
    """只保留最近 N 条消息，但**不能把配对切散**：往前多留几条直到工具结果都带着调用。"""
    size = len(turns)
    start = max(0, size - max(1, keep))
    while 0 < start < size:
        role = ((turns[start] or {}).get("role") or "").lower()
        if role == ROLE_TOOL:
            start -= 1
        else:
            break
    return turns[start:]


def _repair_pairs(messages: list[dict]) -> list[dict]:
    """mewcode `ToolPairing.ensure` 的等价实现：补齐没结果的工具调用、丢掉孤儿结果。"""
    issued = {call["id"] for message in messages for call in message.get("tool_calls") or []}
    resolved = {message.get("tool_call_id") for message in messages if message.get("tool_call_id")}

    repaired: list[dict] = []
    for message in messages:
        tool_call_id = message.get("tool_call_id")
        if tool_call_id and tool_call_id not in issued:
            continue  # 孤儿工具结果：丢掉
        repaired.append(message)
        for call in message.get("tool_calls") or []:
            if call["id"] not in resolved:
                repaired.append({
                    "role": ROLE_TOOL,
                    "tool_call_id": call["id"],
                    "content": json.dumps({
                        "status": "interrupted",
                        "note": "这次工具调用没有拿到结果，可能被中断了；不要假设它已经生效",
                    }, ensure_ascii=False),
                })
                resolved.add(call["id"])
    return repaired


def _system_prompt(scope, zone: ZoneInfo, now: datetime) -> str:
    """渲染系统提示：环境事实由服务端注入，行为规格全部来自 prompt.md。"""
    weekday = "周" + "日一二三四五六"[now.isoweekday() % 7]
    org_line = (
        f"用户当前正在「{scope.org_name}」这个组织里，但你只能操作他个人的日程。"
        if scope.has_org
        else "用户当前没有选择组织。"
    )
    return agent_prompt.render({
        "today": now.date().isoformat(),
        "weekday": weekday,
        "now": f"{now.hour:02d}:{now.minute:02d}",
        "timezone": zone.key,
        "org_line": org_line,
    })


def _tool_event(call: dict, outcome: agent_tools.ToolOutcome) -> dict:
    return {
        "toolCallId": call["id"],
        "name": call["name"],
        "arguments": call.get("arguments"),
        "result": outcome.json,
        "readOnly": outcome.read_only,
        "summary": outcome.summary,
        "detail": outcome.detail,
    }


def _status_of(tool_name: str) -> dict:
    """查询类工具在动手前先告诉用户"正在做什么"。"""
    if tool_name == agent_tools.LIST_MY_EVENTS:
        return {"stage": "querying_events", "label": "正在查日程…"}
    if tool_name == agent_tools.READ_MY_EVENT_NOTE:
        return {"stage": "querying_events", "label": "正在读备注…"}
    if tool_name == agent_tools.CREATE_MY_EVENT:
        return {"stage": "preparing_create", "label": "正在准备创建…"}
    if tool_name == agent_tools.UPDATE_MY_EVENT:
        return {"stage": "preparing_update", "label": "正在准备修改…"}
    if tool_name == agent_tools.DELETE_MY_EVENT:
        return {"stage": "preparing_delete", "label": "正在准备删除…"}
    return {"stage": "working", "label": "正在处理…"}


def _new_action_id(seq: int) -> str:
    """**必须全局唯一**：客户端按 id 认授权卡片，跨轮重号会让第二次的「拒绝」命中
    第一条（已处理）的卡片而直接返回——用户点拒绝没有任何反应（2026-09-29 实测）。"""
    return f"a{int(time.time_ns()):x}-{seq}"


def _last_user_text(turns) -> str:
    for turn in reversed(turns or []):
        if not isinstance(turn, dict):
            continue
        if (turn.get("role") or "").lower() == ROLE_USER and (turn.get("content") or "").strip():
            return turn["content"].strip()
    return ""


def _has_write_verb(text: str) -> bool:
    """窄口径：只有**明确的写动词**才算（用在"已经查过日程"之后）。"""
    return bool(text) and any(verb in text for verb in WRITE_VERBS)


def _looks_like_write_intent(text: str) -> bool:
    """这句话是不是"要写点什么"的意思（宽口径）。

    两种信号满足其一就算：**动词**，或 **时间词 + 事件味**——后者是实测补上的：
    「明天下午三点和张总开会」这种最常见的说法里一个动词都没有。
    仍然宁可漏、不多管闲事：纯闲聊（"你好"）不会命中任何一条。
    """
    if not text:
        return False
    if _has_write_verb(text):
        return True
    if any(marker in text for marker in EVENT_MARKERS):
        return True
    if any(marker in text for marker in TIME_MARKERS):
        return True
    import re
    return bool(re.search(r"\d{1,2}[点:：]", text))
