"""小安（智能助手）的服务端链路（spec §11 阶段三）。

用脚本化的假模型替换真实上游：这里验证的是**我们这一侧**的行为——
工具白名单、个人日程沙盒、写操作要用户授权才落库、提示词与 Java 版一致、未配置时降级。
模型答得好不好不由单测管，那是提示词调优的事。

与 Java 版 `AgentModuleTest` 覆盖同一批不变量；两版协议（SSE 事件名与字段）也必须一致。
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
JAVA_PROMPT = REPO_ROOT / "backend-java" / "chronoflow-agent" / "src" / "main" / "resources" / "agent" / "prompt.md"

# 模块导入期**不要**碰 app.* —— conftest 还没把 DATABASE_URL 塞进环境（踩过，见 test_vision）


class ScriptedModel:
    """脚本化的假上游：按顺序吐出预设结果，并记录每次请求（用于断言"回灌给模型的是什么"）。"""

    def __init__(self, *, available: bool = True) -> None:
        self.available_flag = available
        self.script: list = []
        self.requests: list[dict] = []
        self.last_transcription = ""
        self.transcribe_calls = 0
        # 「OCR 文字 → 日程草稿」那一路的返回值与请求（与对话脚本分开，互不串味）
        self.last_json = '{"items":[]}'
        self.json_prompts: list[str] = []

    def enqueue(self, text: str, tool_calls: list[dict] | None = None) -> None:
        from app.services.agent_model import CompletionResult

        self.script.append(CompletionResult(
            text=text,
            tool_calls=list(tool_calls or []),
            finish_reason="tool_calls" if tool_calls else "stop",
            prompt_tokens=100,
            completion_tokens=20,
        ))

    # ---- AgentModelClient 的形状

    def provider_name(self) -> str:
        return "scripted" if self.available_flag else "unconfigured"

    def available(self) -> bool:
        return self.available_flag

    def transcription_available(self) -> bool:
        return self.available_flag

    def complete(self, messages, tools, on_delta):
        self.requests.append({"messages": messages, "tools": tools})
        if not self.script:
            raise AssertionError("假模型的脚本用完了：这次请求没有预设结果")
        result = self.script.pop(0)
        if result.text:
            on_delta(result.text)
        return result

    def transcribe(self, audio, content_type):
        from app.services.agent_model import TranscriptionResult

        self.transcribe_calls += 1
        return TranscriptionResult(text=self.last_transcription, language="zh")

    def complete_json(self, prompt):
        self.json_prompts.append(prompt)
        return self.last_json


@pytest.fixture()
def model():
    """每个用例一个干净的假上游：它是模块级单例，串脚本会让失败看起来像另一个用例的问题。"""
    from app.services import agent_model

    fake = ScriptedModel()
    agent_model.set_client(fake)
    try:
        yield fake
    finally:
        agent_model.set_client(None)


# ------------------------------------------------------------------ 基础材料


def send_code(client, phone: str) -> str:
    body = client.post("/api/v1/auth/sms/code", json={"phone": phone}).json()
    assert body["code"] == 0, body
    return body["data"]["debugCode"]


def register(client, phone: str) -> dict:
    login = client.post(
        "/api/v1/auth/login/sms",
        json={"phone": phone, "code": send_code(client, phone), "deviceId": "device-agent"},
    ).json()
    assert login["data"]["needRegister"] is True, login
    created = client.post(
        "/api/v1/identities/personal",
        json={"nickname": "助手用户", "deviceId": "device-agent"},
        headers={"Authorization": f"Bearer {login['data']['registerToken']}"},
    ).json()
    assert created["code"] == 0, created
    return created["data"]


def auth(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['accessToken']}"}


def account_id(tokens: dict) -> int:
    return int(tokens["identity"]["accountId"])


def scope_of(tokens: dict, org_identity_id: int | None = None):
    from app.db import SessionLocal
    from app.services import agent_scope

    with SessionLocal() as session:
        return agent_scope.resolve(session, account_id(tokens), org_identity_id)


def create_event(client, tokens: dict, title: str, at: str) -> dict:
    body = client.post(
        "/api/v1/events",
        json={"title": title, "at": at, "timezone": "Asia/Shanghai"},
        headers=auth(tokens),
    ).json()
    assert body["code"] == 0, body
    return body["data"]


def drive(scope, turns, on_event) -> list[tuple[str, dict]]:
    """跑一次对话，把收到的事件收集起来（`on_event` 可以在中途答复授权）。"""
    from app.services import agent_chat

    async def scenario():
        seen: list[tuple[str, dict]] = []
        async for name, data in agent_chat.events(scope, turns):
            seen.append((name, data))
            on_event(name, data, seen)
        return seen

    return asyncio.run(scenario())


def await_pending(timeout: float = 10.0) -> str:
    from app.services import agent_approvals

    deadline = time.time() + timeout
    while time.time() < deadline:
        pending = agent_approvals.pending_action_ids()
        if pending:
            return next(iter(pending))
        time.sleep(0.02)
    raise AssertionError("等不到待授权")


# ---------------------------------------------------------------------- 用例


def test_agent_prompt_is_the_same_file_as_java() -> None:
    """两版用的是**同一份提示词**：文件逐字节相同，否则线上跑的可能不是你以为的那版。"""
    from app.services import agent_prompt

    assert agent_prompt.template() == JAVA_PROMPT.read_text(encoding="utf-8")
    rendered = agent_prompt.render({
        "today": "2026-09-30",
        "weekday": "周三",
        "now": "10:00",
        "timezone": "Asia/Shanghai",
        "org_line": "用户当前没有选择组织。",
    })
    assert "2026-09-30" in rendered and "周三" in rendered
    assert "{{" not in rendered


def test_parse_text_endpoint_extracts_todos_with_optional_date(client, model) -> None:
    """OCR 文字 → 日程草稿：缺日期的条目照样返回、带 timezone、没有 kind（spec §4.1.9）。"""
    tokens = register(client, "13900007010")
    model.last_json = """
    好的，识别结果如下：
    ```json
    {"items":[
      {"title":"离返校登记","at":"2026-09-24T00:00:00+08:00","timezone":"Asia/Shanghai"},
      {"title":"填写返校情况统计表","timezone":"Asia/Shanghai","description":"金山文档填写"}
    ]}
    ```
    """
    body = client.post(
        "/api/v1/ai/events/parse-text",
        json={
            "text": "9 月 24 日前登记；二、返校情况统计请填写",
            "today": "2026-09-30",
            "timezone": "Asia/Shanghai",
        },
        headers=auth(tokens),
    ).json()

    assert body["code"] == 0, body
    items = body["data"]["items"]
    assert [item["title"] for item in items] == ["离返校登记", "填写返校情况统计表"]
    assert items[0]["at"].startswith("2026-09-24T00:00")
    assert items[0]["timezone"] == "Asia/Shanghai"
    assert "kind" not in items[0]
    # 没写日期的那条：at 为 null，但条目本身必须在
    assert items[1]["at"] is None
    # 提示词里带上了今天与时区，模型才有依据换算相对时间
    prompt = model.json_prompts[-1]
    assert "2026-09-30" in prompt and "Asia/Shanghai" in prompt
    assert "要你做的事" in prompt


def test_parse_text_reports_unavailable_when_model_missing(client, model) -> None:
    tokens = register(client, "13900007011")
    model.available_flag = False
    body = client.post(
        "/api/v1/ai/events/parse-text",
        json={"text": "9 月 24 日前登记", "today": "2026-09-30", "timezone": "Asia/Shanghai"},
        headers=auth(tokens),
    ).json()
    assert body["code"] == 90002


def test_agent_tools_are_personal_only(client) -> None:
    """工具白名单：只有五个 my_ 前缀的工具，且都在个人日程范围内。"""
    from app.services import agent_tools

    names = [spec["function"]["name"] for spec in agent_tools.specs()]
    assert names == [
        "list_my_events", "read_my_event_note", "create_my_event",
        "update_my_event", "delete_my_event",
    ]
    assert all(name.startswith("my_") or "_my_" in name for name in names)
    assert agent_tools.is_read_only("list_my_events")
    assert agent_tools.is_read_only("read_my_event_note")
    assert not agent_tools.is_read_only("create_my_event")
    assert not agent_tools.is_read_only("delete_my_event")


def test_agent_cannot_touch_other_peoples_events(client, db) -> None:
    """隔离沙盒：别人的日程一律当「找不到」，改不动也删不掉。"""
    from app.services import agent_tools

    alice = register(client, "13900007001")
    bob = register(client, "13900007002")
    event = create_event(client, alice, "别人的张总会", "2026-10-08T15:00:00+08:00")

    scope = scope_of(bob)
    zone = ZoneInfo("Asia/Shanghai")
    now = datetime.now(zone)
    for tool in ("update_my_event", "delete_my_event"):
        outcome = agent_tools.invoke(
            scope,
            {"id": "c1", "name": tool, "arguments": json.dumps({"eventId": event["id"]})},
            "a1",
            now,
            zone,
        )
        assert outcome.action is None, f"{tool} 不该对别人的日程出授权"
        assert "找不到" in outcome.json

    # 同事的日程原封不动
    assert db.execute(
        "SELECT count(*) FROM event WHERE id = %s AND deleted_at IS NULL", (event["id"],)
    ).fetchone()[0] == 1


def test_agent_list_and_note_tools(client) -> None:
    """查日程与读备注：窗口必填、列表只给 60 字预览、全文靠 offset/length 分段读。"""
    from app.services import agent_tools

    tokens = register(client, "13900007009")
    long_note = "第" * 120
    created = client.post(
        "/api/v1/events",
        json={"title": "季度评审", "at": "2026-10-08T09:00:00+08:00",
              "timezone": "Asia/Shanghai", "description": long_note},
        headers=auth(tokens),
    ).json()
    assert created["code"] == 0, created

    scope = scope_of(tokens)
    zone = ZoneInfo("Asia/Shanghai")
    now = datetime.now(zone)

    listed = agent_tools.invoke(scope, {
        "id": "c1", "name": "list_my_events",
        "arguments": json.dumps({"from": "2026-10-01T00:00:00+08:00",
                                 "to": "2026-11-01T00:00:00+08:00"}),
    }, None, now, zone)
    payload = json.loads(listed.json)
    assert payload["total"] == 1
    assert payload["events"][0]["title"] == "季度评审"
    assert payload["events"][0]["noteLength"] == len(long_note)
    assert len(payload["events"][0]["notePreview"]) <= agent_tools.NOTE_PREVIEW_LIMIT + 1

    # 时间窗口必填：不猜
    missing = agent_tools.invoke(scope, {
        "id": "c2", "name": "list_my_events", "arguments": "{}",
    }, None, now, zone)
    assert missing.action is None and "from" in missing.json

    note = agent_tools.invoke(scope, {
        "id": "c3", "name": "read_my_event_note",
        "arguments": json.dumps({"eventId": created["data"]["id"], "offset": 100, "length": 500}),
    }, None, now, zone)
    note_payload = json.loads(note.json)
    assert note_payload["total"] == len(long_note)
    assert note_payload["hasMore"] is False
    assert note_payload["length"] == 20


def test_agent_chat_writes_only_after_approval(client, db, model) -> None:
    """写操作先申请授权；用户允许之后服务端才真正落库（与 REST 同一套 Service）。"""
    tokens = register(client, "13900007003")
    model.enqueue("好。", [{
        "id": "call_1", "name": "create_my_event",
        "arguments": json.dumps({"title": "审批后才建的会", "at": "2026-10-08T15:00:00+08:00"}),
    }])
    model.enqueue("已经开上了。")

    actions: list[dict] = []

    def on_event(name, data, seen):
        if name == "action":
            actions.append(data)
            # 同一根事件循环里答复，跟真实客户端打 /ai/agent/approvals 等价
            from app.services import agent_approvals

            assert agent_approvals.resolve(account_id(tokens), data["actionId"], True, None)

    seen = drive(scope_of(tokens), [{"role": "user", "content": "明天下午三点和张总开会"}], on_event)
    names = [name for name, _ in seen]
    assert names.count("action") == 1
    assert "tool" in names and names[-1] == "done"

    assert actions[0]["type"] == "create_event"
    assert actions[0]["payload"]["title"] == "审批后才建的会"
    assert db.execute(
        "SELECT count(*) FROM event WHERE title = '审批后才建的会' AND deleted_at IS NULL"
    ).fetchone()[0] == 1

    # 工具结果回灌给模型的是「已写入」，最后一轮模型据此收尾
    last = model.requests[-1]["messages"]
    assert any(message.get("role") == "tool" and '"status": "ok"' in (message.get("content") or "")
               for message in last)


def test_agent_reject_writes_nothing(client, db, model) -> None:
    """拒绝：写一条「什么都没改」的工具结果，库里一条都不该有，同一条流继续跑。"""
    tokens = register(client, "13900007004")
    model.enqueue("好。", [{
        "id": "call_1", "name": "create_my_event",
        "arguments": json.dumps({"title": "别建这条", "at": "2026-10-08T15:00:00+08:00"}),
    }])
    model.enqueue("那就不建了。")

    def on_event(name, data, seen):
        if name == "action":
            from app.services import agent_approvals

            assert agent_approvals.resolve(account_id(tokens), data["actionId"], False, None)

    seen = drive(scope_of(tokens), [{"role": "user", "content": "建个『别建这条』"}], on_event)
    names = [name for name, _ in seen]
    assert names[-1] == "done"
    rejected = [data for name, data in seen if name == "tool" and data["summary"] == "已拒绝"]
    assert len(rejected) == 1
    assert "什么都没有改动" in rejected[0]["result"]
    assert db.execute(
        "SELECT count(*) FROM event WHERE title = '别建这条'"
    ).fetchone()[0] == 0


def test_agent_chat_http_end_to_end_with_approval(client, db, model) -> None:
    """协议层面走一遍：SSE 里出现 action → 打 /ai/agent/approvals 允许 → 流继续到 done。"""
    tokens = register(client, "13900007005")
    model.enqueue("好。", [{
        "id": "call_1", "name": "create_my_event",
        "arguments": json.dumps({"title": "HTTP 张总会", "at": "2026-10-08T15:00:00+08:00"}),
    }])
    model.enqueue("已经开上了。")

    box: dict = {}

    def post_chat() -> None:
        # 线程里发这条流：主线程要腾出来去调审批接口（跟客户端真实行为一致）
        box["response"] = client.post(
            "/api/v1/ai/agent/chat",
            json={"messages": [{"role": "user", "content": "明天下午三点和张总开会"}]},
            headers=auth(tokens),
        )

    worker = threading.Thread(target=post_chat, daemon=True)
    worker.start()
    action_id = await_pending()

    approved = client.post(
        "/api/v1/ai/agent/approvals",
        json={"actionId": action_id, "allow": True},
        headers=auth(tokens),
    ).json()
    assert approved["code"] == 0, approved

    worker.join(timeout=20)
    assert not worker.is_alive(), "答复之后这条流没有继续跑完"
    body = box["response"].text
    assert "event: action" in body and "event: done" in body
    assert db.execute(
        "SELECT count(*) FROM event WHERE title = 'HTTP 张总会' AND deleted_at IS NULL"
    ).fetchone()[0] == 1


def test_agent_unconfigured_reports_unavailable(client) -> None:
    """模型未配置：不开流、直接 90002；/system/info 如实上报 aiAgentEnabled=false。"""
    from app.services import agent_model

    tokens = register(client, "13900007006")
    agent_model.set_client(ScriptedModel(available=False))
    try:
        assert client.get("/api/v1/system/info").json()["data"]["aiAgentEnabled"] is False

        chat = client.post(
            "/api/v1/ai/agent/chat",
            json={"messages": [{"role": "user", "content": "在吗"}]},
            headers=auth(tokens),
        ).json()
        assert chat["code"] == 90002, chat

        transcribe = client.post(
            "/api/v1/ai/transcribe",
            files={"file": ("voice.m4a", b"\x01\x02\x03", "audio/mp4")},
            headers=auth(tokens),
        ).json()
        assert transcribe["code"] == 90002, transcribe
    finally:
        agent_model.set_client(None)


def test_agent_org_identity_must_belong_to_the_account(client, model) -> None:
    """orgIdentityId 是不能信的输入：不是自己的组织身份一律 20003。"""
    tokens = register(client, "13900007007")
    response = client.post(
        "/api/v1/ai/agent/chat",
        json={"messages": [{"role": "user", "content": "在吗"}], "orgIdentityId": 999999},
        headers=auth(tokens),
    ).json()
    assert response["code"] == 20003, response


def test_agent_transcribe_validates_before_calling_upstream(client, model) -> None:
    """语音输入：正常返回文字；忘带文件与超限都当场拒掉，不打上游。"""
    tokens = register(client, "13900007008")
    model.last_transcription = "说明天下午三点和张总开会"

    ok = client.post(
        "/api/v1/ai/transcribe",
        files={"file": ("voice.m4a", b"\x01\x02\x03", "audio/mp4")},
        headers=auth(tokens),
    ).json()
    assert ok["code"] == 0, ok
    assert ok["data"]["text"] == "说明天下午三点和张总开会"
    assert model.transcribe_calls == 1

    missing = client.post("/api/v1/ai/transcribe", headers=auth(tokens)).json()
    assert missing["code"] == 10001, missing

    from app.config import settings

    oversized = client.post(
        "/api/v1/ai/transcribe",
        files={"file": ("long.m4a", b"0" * (settings.agent_asr_max_bytes + 1), "audio/mp4")},
        headers=auth(tokens),
    ).json()
    assert oversized["code"] == 10002, oversized
    assert model.transcribe_calls == 1, "参数就不对，不该打上游"
