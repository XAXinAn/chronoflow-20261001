"""个人 / 组织 / 超管三个模块的关键行为（与 Java 版测试覆盖同一批语义）。"""

from __future__ import annotations

import json
from datetime import datetime
from zoneinfo import ZoneInfo

from app.errors import ErrorCode
from test_auth_flow import auth, register, send_code

SHANGHAI = ZoneInfo("Asia/Shanghai")

WEEKLY_PAYLOAD = {
    "title": "站会",
    "startAt": "2026-10-05T09:00:00+08:00",
    "endAt": "2026-10-05T09:30:00+08:00",
    "timezone": "Asia/Shanghai",
    "rrule": "FREQ=WEEKLY;BYDAY=MO,WE,FR",
}


def create_event(client, tokens, payload: dict) -> dict:
    response = client.post("/api/v1/events", json=payload, headers=auth(tokens)).json()
    assert response["code"] == 0, response
    return response["data"]


def range_query(client, tokens, start: str, end: str) -> list[dict]:
    response = client.get(
        "/api/v1/events", params={"start": start, "end": end}, headers=auth(tokens)
    ).json()
    assert response["code"] == 0, response
    return response["data"]


def search(client, tokens, keyword: str, **params) -> list[dict]:
    response = client.get(
        "/api/v1/search", params={"keyword": keyword, **params}, headers=auth(tokens)
    ).json()
    assert response["code"] == 0, response
    return response["data"]


def create_task(client, tokens, payload: dict) -> dict:
    response = client.post("/api/v1/tasks", json=payload, headers=auth(tokens)).json()
    assert response["code"] == 0, response
    return response["data"]


def test_search_spans_events_and_tasks_in_time_desc_order(client) -> None:
    """检索跨日程与待办，按时间倒序、无时间的待办排最后（spec §4.1.7）。"""
    tokens = register(client, "13900002101")
    create_event(
        client,
        tokens,
        {
            "title": "评审会彩排",
            "startAt": "2026-10-05T10:00:00+08:00",
            "endAt": "2026-10-05T11:00:00+08:00",
        },
    )
    create_event(
        client,
        tokens,
        {
            "title": "技术评审会",
            "startAt": "2026-09-20T10:00:00+08:00",
            "endAt": "2026-09-20T11:00:00+08:00",
        },
    )
    create_task(client, tokens, {"title": "写评审会纪要", "dueAt": "2026-09-25T18:00:00+08:00"})
    create_task(client, tokens, {"title": "评审会后续跟进"})

    items = search(client, tokens, "评审会")

    assert [item["title"] for item in items] == [
        "评审会彩排",
        "写评审会纪要",
        "技术评审会",
        "评审会后续跟进",
    ]
    assert [item["type"] for item in items] == ["EVENT", "TASK", "EVENT", "TASK"]
    # 无时间的待办排在最后，且确实没有截止时间
    assert items[-1]["dueAt"] is None


def test_search_is_scoped_to_own_identity_and_can_filter_types(client) -> None:
    mine = register(client, "13900002102")
    others = register(client, "13900002103")
    create_event(
        client,
        mine,
        {
            "title": "我的评审会",
            "startAt": "2026-10-05T10:00:00+08:00",
            "endAt": "2026-10-05T11:00:00+08:00",
        },
    )
    create_event(
        client,
        others,
        {
            "title": "别人的评审会",
            "startAt": "2026-10-06T10:00:00+08:00",
            "endAt": "2026-10-06T11:00:00+08:00",
        },
    )
    create_task(client, mine, {"title": "评审会待办"})

    assert [item["title"] for item in search(client, mine, "评审会")] == ["我的评审会", "评审会待办"]
    assert [item["title"] for item in search(client, mine, "评审会", types="TASK")] == ["评审会待办"]
    assert [item["title"] for item in search(client, mine, "评审会", types="EVENT")] == ["我的评审会"]


def test_search_treats_wildcards_as_literals(client) -> None:
    """关键字里的 % / _ 不是通配符：不转义就成了「搜什么都灵」（spec §4.1.7）。"""
    tokens = register(client, "13900002104")
    create_event(
        client,
        tokens,
        {
            "title": "50% 折扣复盘",
            "startAt": "2026-10-05T10:00:00+08:00",
            "endAt": "2026-10-05T11:00:00+08:00",
        },
    )
    create_event(
        client,
        tokens,
        {
            "title": "普通复盘",
            "startAt": "2026-10-06T10:00:00+08:00",
            "endAt": "2026-10-06T11:00:00+08:00",
        },
    )

    assert [item["title"] for item in search(client, tokens, "50%")] == ["50% 折扣复盘"]
    assert search(client, tokens, "_") == []


def test_search_resolves_upcoming_occurrence_for_recurring_event(client) -> None:
    """命中的是重复序列时，要给出最近一次实例的日期，而不是序列起点。"""
    tokens = register(client, "13900002105")
    create_event(
        client,
        tokens,
        {
            "title": "周会",
            "startAt": "2026-09-07T09:00:00+08:00",
            "endAt": "2026-09-07T10:00:00+08:00",
            "timezone": "Asia/Shanghai",
            "rrule": "FREQ=WEEKLY;BYDAY=MO",
        },
    )

    item = search(client, tokens, "周会")[0]

    assert item["recurring"] is True
    assert item["occurrenceDate"] is not None
    # 断言「形态」而不是「具体哪一天」：最近一次实例随运行日期变化，
    # 真正要守住的是「落在周一 09:00 的本地墙上时间」
    start = datetime.fromisoformat(item["startAt"]).astimezone(SHANGHAI)
    assert (start.hour, start.minute) == (9, 0)
    assert start.isoweekday() == 1


def test_search_rejects_blank_keyword(client) -> None:
    tokens = register(client, "13900002106")
    response = client.get("/api/v1/search", params={"keyword": "   "}, headers=auth(tokens)).json()
    assert response["code"] != 0


def test_holidays_are_returned_by_month_and_year(client, db) -> None:
    """节假日按年月取，区分放假与调休上班（spec §5.11）。"""
    for day, name, day_type in (
        ("2026-09-25", "中秋节", "HOLIDAY"),
        ("2026-09-27", "中秋节", "WORKDAY"),
        ("2026-10-01", "国庆节", "HOLIDAY"),
    ):
        db.execute(
            "INSERT INTO holiday (country_code, holiday_date, name, day_type)"
            " VALUES ('zh-CN', %s::date, %s, %s)"
            " ON CONFLICT (country_code, holiday_date)"
            " DO UPDATE SET name = EXCLUDED.name, day_type = EXCLUDED.day_type",
            (day, name, day_type),
        )

    tokens = register(client, "13900002107")
    september = client.get(
        "/api/v1/holidays", params={"year": 2026, "month": 9}, headers=auth(tokens)
    ).json()["data"]
    assert september["country"] == "zh-CN"
    assert [(item["date"], item["dayType"]) for item in september["days"]] == [
        ("2026-09-25", "HOLIDAY"),
        ("2026-09-27", "WORKDAY"),
    ]
    assert september["days"][0]["name"] == "中秋节"

    # 省略 month 返回全年：翻月不该被月度切片限制
    whole_year = client.get(
        "/api/v1/holidays", params={"year": 2026}, headers=auth(tokens)
    ).json()["data"]
    # 断言「包含这三条」而不是「一共三条」：同类里其它用例（含自动同步）也会往这张表写，
    # 总数会互相影响，但「本用例插入的都在」是稳定的事实
    assert {item["date"] for item in whole_year["days"]} >= {
        "2026-09-25",
        "2026-09-27",
        "2026-10-01",
    }
    assert whole_year["month"] is None

    # country 大小写归一：zh-cn 与 zh-CN 命中同一份数据
    lower = client.get(
        "/api/v1/holidays", params={"year": 2026, "month": 9, "country": "zh-cn"}, headers=auth(tokens)
    ).json()["data"]
    assert len(lower["days"]) == 2


def test_holiday_year_without_data_returns_empty(client) -> None:
    """没有数据的年份返回空数组，不猜测也不硬编码兜底。"""
    tokens = register(client, "13900002108")
    data = client.get(
        "/api/v1/holidays", params={"year": 2031}, headers=auth(tokens)
    ).json()["data"]
    assert data["year"] == 2031
    assert data["days"] == []


def _holiday_days(client, tokens, year: int) -> list[dict]:
    return client.get(
        "/api/v1/holidays", params={"year": year}, headers=auth(tokens)
    ).json()["data"]["days"]


def test_holiday_sync_upserts_and_clears_cache(client, db, monkeypatch) -> None:
    """定时同步：拉上游数据入库，并立刻清掉缓存（否则界面还是旧的）。"""
    from app.services import holiday_sync
    from app.services.holiday import clear_cache

    year = datetime.now(ZoneInfo("Asia/Shanghai")).year
    tokens = register(client, "13900002201")
    # 缓存是进程级的，且本用例会绕过缓存直接写库：先清一次，读到的才是库里的真实状态
    clear_cache()

    def fake_fetch(target: int) -> str | None:
        if target != year:
            # 次年在通知发布前上游就是没有数据
            return None
        return json.dumps(
            {
                "year": year,
                "papers": ["https://example.gov/notice"],
                "days": [
                    {"name": "国庆节", "date": f"{year}-10-01", "isOffDay": True},
                    {"name": "国庆节", "date": f"{year}-10-10", "isOffDay": False},
                ],
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(holiday_sync, "_fetch", fake_fetch)

    first = _holiday_days(client, tokens, year)
    # 直接写库（绕过服务层缓存），再读一次：必须还是旧值，否则说明缓存根本没生效
    db.execute(
        "INSERT INTO holiday (country_code, holiday_date, name, day_type)"
        " VALUES ('zh-CN', %s::date, '劳动节', 'HOLIDAY')"
        " ON CONFLICT (country_code, holiday_date) DO NOTHING",
        (f"{year}-05-01",),
    )
    cached = _holiday_days(client, tokens, year)
    assert cached == first, "库里改了但缓存未失效，这里应该还是旧值"

    holiday_sync.sync_once()

    after = _holiday_days(client, tokens, year)
    assert len(after) > len(cached), "同步后必须立刻可见（缓存被清）"
    assert any(item["name"] == "国庆节" for item in after)
    assert any(item["dayType"] == "WORKDAY" for item in after), "调休上班日也要同步进来"

    state = holiday_sync.status()
    assert state["lastSuccessAt"] is not None
    assert state["lastError"] is None
    assert state["lastSyncedDays"] == 2
    # 状态要能从 /system/info 看到：后台任务静默失败是排查噩梦
    info = client.get("/api/v1/system/info").json()["data"]["holidaySync"]
    assert info["lastSuccessAt"] is not None
    assert info["enabled"] is False  # 测试环境显式关掉了自动调度


def test_holiday_sync_skips_malformed_year_without_partial_write(client, monkeypatch) -> None:
    from app.services import holiday_sync
    from app.services.holiday import clear_cache

    year = datetime.now(ZoneInfo("Asia/Shanghai")).year
    tokens = register(client, "13900002202")
    clear_cache()
    before = _holiday_days(client, tokens, year)

    # 第 2 条缺 date：整年都不该写进去（半截数据比旧数据更难排查）
    monkeypatch.setattr(
        holiday_sync,
        "_fetch",
        lambda target: json.dumps(
            {
                "year": target,
                "days": [
                    {"name": "元旦", "date": f"{target}-01-01", "isOffDay": True},
                    {"name": "春节", "isOffDay": True},
                ],
            },
            ensure_ascii=False,
        )
        if target == year
        else None,
    )

    holiday_sync.sync_once()

    after = _holiday_days(client, tokens, year)
    # 第一条是合法的「元旦 01-01」，但它同样不该落库——这一年整年放弃
    assert {item["date"] for item in after} == {item["date"] for item in before}
    assert not any(item["name"] == "元旦" for item in after)
    assert "缺少日期或名称" in (holiday_sync.status()["lastError"] or "")


def test_seconds_until_next_run_is_computed_in_app_timezone() -> None:
    """每日同步时刻按东八区计算，与 Java 版 cron 对齐。"""
    from app.services import holiday_sync

    zone = ZoneInfo("Asia/Shanghai")
    # 凌晨 1:00 → 当天 3:10，还有 2 小时 10 分
    assert holiday_sync.seconds_until_next_run(datetime(2026, 9, 25, 1, 0, tzinfo=zone)) == 7800.0
    # 凌晨 4:00（已过今天的 3:10）→ 明天的 3:10
    assert (
        holiday_sync.seconds_until_next_run(datetime(2026, 9, 25, 4, 0, tzinfo=zone)) == 83400.0
    )


# 1x1 的 PNG 头 + 填充：只要够短，服务端只按文件头判定格式
PNG_BYTES = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 24


def test_upload_checks_file_header_not_declared_mime(client) -> None:
    """上传通道：按文件头判定格式，不信任客户端声明的 MIME（spec §5.10）。"""
    tokens = register(client, "13900002301")

    # 声明成 image/jpeg，内容却是文本——把 .exe 改名成 .jpg 就是这个形状
    fake = client.post(
        "/api/v1/uploads/images",
        files={"file": ("evil.jpg", b"not an image at all", "image/jpeg")},
        headers=auth(tokens),
    ).json()
    assert fake["code"] == ErrorCode.UPLOAD_TYPE_UNSUPPORTED

    uploaded = client.post(
        "/api/v1/uploads/images",
        files={"file": ("shot.png", PNG_BYTES, "image/png")},
        headers=auth(tokens),
    ).json()
    assert uploaded["code"] == 0, uploaded
    data = uploaded["data"]
    assert data["url"].startswith("/uploads/") and data["url"].endswith(".png")
    assert data["contentType"] == "image/png"
    assert data["size"] == len(PNG_BYTES)

    # 文件名取内容哈希：同一张图重复上传得到同一个 URL（天然去重）
    again = client.post(
        "/api/v1/uploads/images",
        files={"file": ("copy.png", PNG_BYTES, "image/png")},
        headers=auth(tokens),
    ).json()
    assert again["data"]["url"] == data["url"]

    # 静态目录必须免鉴权：<Image> 直接按 URL 取图，带不了 Authorization
    served = client.get(data["url"])
    assert served.status_code == 200
    assert served.content == PNG_BYTES


def test_upload_rejects_oversized_file(client) -> None:
    from app.services.storage import DEFAULT_MAX_BYTES

    tokens = register(client, "13900002302")
    oversized = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * DEFAULT_MAX_BYTES

    response = client.post(
        "/api/v1/uploads/images",
        files={"file": ("big.png", oversized, "image/png")},
        headers=auth(tokens),
    ).json()

    assert response["code"] == ErrorCode.UPLOAD_TOO_LARGE


def test_feedback_submit_and_list_only_mine(client) -> None:
    """意见反馈：提交后进入 OPEN，用户只能看到自己的（spec §4.1.9）。"""
    mine = register(client, "13900002303")
    other = register(client, "13900002304")

    created = client.post(
        "/api/v1/feedback",
        json={"category": "BUG", "content": "日历页周末的休/班标记有时不显示", "images": ["/uploads/a.png"]},
        headers=auth(mine),
    ).json()
    assert created["code"] == 0, created
    data = created["data"]
    assert data["status"] == "OPEN"
    assert data["images"] == ["/uploads/a.png"]
    # createdAt 由数据库生成：接口返回的是从库里读回来的那条，不是内存对象
    assert data["createdAt"] is not None
    assert data["handledAt"] is None

    # 分类非法
    bad_category = client.post(
        "/api/v1/feedback", json={"category": "NOPE", "content": "x"}, headers=auth(mine)
    ).json()
    assert bad_category["code"] == ErrorCode.PARAM_INVALID
    # 内容必填
    empty = client.post("/api/v1/feedback", json={"category": "BUG", "content": "  "}, headers=auth(mine)).json()
    assert empty["code"] != 0
    # 图片只接受本服务上传通道的相对 URL：外链等于让别人在我们的界面上打广告
    external = client.post(
        "/api/v1/feedback",
        json={"category": "BUG", "content": "x", "images": ["https://evil.example/a.png"]},
        headers=auth(mine),
    ).json()
    assert external["code"] == ErrorCode.PARAM_INVALID

    assert [item["id"] for item in client.get("/api/v1/feedback", headers=auth(mine)).json()["data"]] == [
        data["id"]
    ]
    assert client.get("/api/v1/feedback", headers=auth(other)).json()["data"] == []


def test_admin_lists_and_handles_feedback(client) -> None:
    """超管查阅与处理反馈（spec §6.3）；重复处理是幂等的。"""
    user = register(client, "13900002305")
    created = client.post(
        "/api/v1/feedback",
        json={"category": "SUGGESTION", "content": "希望支持把日程导出成 ics"},
        headers=auth(user),
    ).json()["data"]

    admin = admin_headers(admin_login(client))
    opened = client.get("/api/v1/admin/feedback", headers=admin).json()["data"]
    assert any(item["id"] == created["id"] for item in opened)
    assert all(item["status"] == "OPEN" for item in opened), "默认只列待处理的"

    handled = client.post(
        f"/api/v1/admin/feedback/{created['id']}/handle", headers=admin
    ).json()["data"]
    assert handled["status"] == "HANDLED"
    assert handled["handledAt"] is not None

    # 处理完就不该再出现在待处理列表里
    still_open = client.get("/api/v1/admin/feedback", headers=admin).json()["data"]
    assert all(item["id"] != created["id"] for item in still_open)
    handled_list = client.get(
        "/api/v1/admin/feedback", params={"status": "HANDLED"}, headers=admin
    ).json()["data"]
    assert any(item["id"] == created["id"] for item in handled_list)

    # 幂等：再点一次不报错，也不改变处理时间
    again = client.post(f"/api/v1/admin/feedback/{created['id']}/handle", headers=admin).json()
    assert again["code"] == 0
    assert again["data"]["handledAt"] == handled["handledAt"]


def test_weekly_recurrence_expands_in_event_timezone(client) -> None:
    tokens = register(client, "13900002001")
    create_event(client, tokens, WEEKLY_PAYLOAD)
    occurrences = range_query(
        client, tokens, "2026-10-05T00:00:00+08:00", "2026-10-18T00:00:00+08:00"
    )
    # 「每周一/三/五 09:00」跨两周 = 6 次，且每次都必须落在当地 09:00
    assert len(occurrences) == 6, occurrences
    for occurrence in occurrences:
        local = datetime.fromisoformat(occurrence["startAt"]).astimezone(SHANGHAI)
        assert (local.hour, local.minute) == (9, 0)


def test_this_scope_modifies_only_one_occurrence(client) -> None:
    tokens = register(client, "13900002002")
    event = create_event(client, tokens, WEEKLY_PAYLOAD)
    updated = client.patch(
        f"/api/v1/events/{event['id']}",
        json={
            "scope": "THIS",
            "occurrenceDate": "2026-10-07",
            "startAt": "2026-10-07T14:00:00+08:00",
            "endAt": "2026-10-07T15:00:00+08:00",
            "title": "临时改期",
        },
        headers=auth(tokens),
    ).json()
    assert updated["code"] == 0, updated
    occurrences = range_query(
        client, tokens, "2026-10-05T00:00:00+08:00", "2026-10-10T00:00:00+08:00"
    )
    assert len(occurrences) == 3
    modified = occurrences[1]
    assert modified["title"] == "临时改期"
    assert modified["modified"] is True
    assert datetime.fromisoformat(occurrences[0]["startAt"]).astimezone(SHANGHAI).hour == 9
    assert datetime.fromisoformat(modified["startAt"]).astimezone(SHANGHAI).hour == 14


def test_future_scope_truncates_and_clones_series(client) -> None:
    tokens = register(client, "13900002004")
    event = create_event(client, tokens, WEEKLY_PAYLOAD)
    split = client.patch(
        f"/api/v1/events/{event['id']}",
        json={
            "scope": "FUTURE",
            "occurrenceDate": "2026-10-12",
            "startAt": "2026-10-12T10:00:00+08:00",
            "endAt": "2026-10-12T10:30:00+08:00",
            "title": "新节奏站会",
        },
        headers=auth(tokens),
    ).json()
    assert split["code"] == 0, split
    assert split["data"]["id"] != event["id"]
    occurrences = range_query(
        client, tokens, "2026-10-05T00:00:00+08:00", "2026-10-18T00:00:00+08:00"
    )
    hours = [datetime.fromisoformat(o["startAt"]).astimezone(SHANGHAI).hour for o in occurrences]
    # 原序列剩 3 次在 09:00，克隆出的新序列 3 次在 10:00
    assert hours == [9, 9, 9, 10, 10, 10], occurrences
    assert occurrences[3]["title"] == "新节奏站会"


def test_task_links_to_event(client) -> None:
    """一个日程可挂多个待办；解绑与「删日程不删待办」都要成立。"""
    tokens = register(client, "13800000311")
    event = create_event(
        client,
        tokens,
        {
            "title": "季度评审",
            "startAt": "2026-10-20T09:00:00+08:00",
            "endAt": "2026-10-20T11:00:00+08:00",
        },
    )

    first = client.post(
        "/api/v1/tasks",
        json={"title": "准备材料", "eventId": event["id"]},
        headers=auth(tokens),
    ).json()["data"]
    client.post(
        "/api/v1/tasks", json={"title": "订会议室", "eventId": event["id"]}, headers=auth(tokens)
    )

    listed = client.get("/api/v1/tasks", headers=auth(tokens)).json()["data"]
    assert len(listed) == 2
    for task in listed:
        assert task["eventId"] == event["id"]
        # 标题由服务端带出来，客户端不必再查一次日程
        assert task["eventTitle"] == "季度评审"

    # 解绑：null 在 PATCH 里是「不修改」，必须靠 clearEvent
    client.patch(f"/api/v1/tasks/{first['id']}", json={"clearEvent": True}, headers=auth(tokens))
    reread = client.get(f"/api/v1/tasks/{first['id']}", headers=auth(tokens)).json()["data"]
    assert reread["eventId"] is None

    # 删日程只解除关联，不删待办
    client.delete(f"/api/v1/events/{event['id']}", headers=auth(tokens))
    remaining = client.get("/api/v1/tasks", headers=auth(tokens)).json()["data"]
    assert len(remaining) == 2
    assert all(task["eventId"] is None for task in remaining)


def test_task_cannot_link_to_others_event(client) -> None:
    owner = register(client, "13800000312")
    stranger = register(client, "13800000313")
    event = create_event(
        client,
        owner,
        {
            "title": "私人日程",
            "startAt": "2026-10-21T09:00:00+08:00",
            "endAt": "2026-10-21T10:00:00+08:00",
        },
    )

    response = client.post(
        "/api/v1/tasks",
        json={"title": "越权关联", "eventId": event["id"]},
        headers=auth(stranger),
    ).json()
    assert response["code"] == ErrorCode.FORBIDDEN


def test_task_update_and_clear_due_at(client) -> None:
    """待办可编辑，且截止时间能被显式清空回到「待安排」。"""
    tokens = register(client, "13800000301")
    created = client.post(
        "/api/v1/tasks",
        json={"title": "交周报", "dueAt": "2026-10-09T18:00:00+08:00", "priority": "LOW"},
        headers=auth(tokens),
    ).json()["data"]

    edited = client.patch(
        f"/api/v1/tasks/{created['id']}",
        json={"title": "交月报", "priority": "HIGH"},
        headers=auth(tokens),
    ).json()["data"]
    assert edited["title"] == "交月报"
    assert edited["priority"] == "HIGH"
    # 只改标题/优先级时，截止时间不该被动到
    assert edited["dueAt"] is not None

    # PATCH 里 null 是「不修改」，清空必须靠 clearDueAt 显式表达
    client.patch(
        f"/api/v1/tasks/{created['id']}", json={"clearDueAt": True}, headers=auth(tokens)
    )
    detail = client.get(f"/api/v1/tasks/{created['id']}", headers=auth(tokens)).json()["data"]
    assert detail["dueAt"] is None


def test_task_images_are_stored_and_validated(client) -> None:
    """待办可带图片附件；外链地址被拒；空数组 = 删光（spec §4.1.3）。"""
    tokens = register(client, "13800000304")
    created = client.post(
        "/api/v1/tasks",
        json={"title": "拍的通知", "images": ["/uploads/notice.png"]},
        headers=auth(tokens),
    ).json()["data"]

    detail = client.get(f"/api/v1/tasks/{created['id']}", headers=auth(tokens)).json()["data"]
    assert detail["images"] == ["/uploads/notice.png"]

    # 外链必须被拒：否则等于让别人在我们的用户界面上打广告
    external = client.post(
        "/api/v1/tasks",
        json={"title": "外链", "images": ["https://evil.example/a.png"]},
        headers=auth(tokens),
    ).json()
    assert external["code"] == ErrorCode.PARAM_INVALID

    # 空数组 = 删光图片（None 才是「不修改」）
    client.patch(f"/api/v1/tasks/{created['id']}", json={"images": []}, headers=auth(tokens))
    cleared = client.get(f"/api/v1/tasks/{created['id']}", headers=auth(tokens)).json()["data"]
    assert cleared["images"] == []


def test_task_delete(client) -> None:
    tokens = register(client, "13800000302")
    created = client.post(
        "/api/v1/tasks", json={"title": "临时待办"}, headers=auth(tokens)
    ).json()["data"]

    response = client.delete(f"/api/v1/tasks/{created['id']}", headers=auth(tokens)).json()
    assert response["code"] == 0
    assert client.get("/api/v1/tasks", headers=auth(tokens)).json()["data"] == []


def test_event_clear_place(client) -> None:
    """清空地点时坐标一并清掉，且必须真的落库（不能只看接口返回）。"""
    tokens = register(client, "13800000303")
    event = create_event(
        client,
        tokens,
        {
            "title": "带地点",
            "startAt": "2026-10-12T09:00:00+08:00",
            "endAt": "2026-10-12T10:00:00+08:00",
            "locationName": "外滩",
            "locationAddress": "上海市黄浦区中山东一路",
            "latitude": 31.24,
            "longitude": 121.49,
            "poiId": "SH-BUND",
        },
    )

    client.patch(f"/api/v1/events/{event['id']}", json={"locationName": ""}, headers=auth(tokens))
    detail = client.get(f"/api/v1/events/{event['id']}", headers=auth(tokens)).json()["data"]
    assert detail["locationName"] is None
    assert detail["locationAddress"] is None
    assert detail["latitude"] is None
    assert detail["longitude"] is None


def test_event_to_task_conversion(client) -> None:
    tokens = register(client, "13900002003")
    event = create_event(
        client,
        tokens,
        {
            "title": "改成待办",
            "startAt": "2026-10-05T09:00:00+08:00",
            "endAt": "2026-10-05T10:00:00+08:00",
            "timezone": "Asia/Shanghai",
        },
    )
    task = client.post(
        f"/api/v1/events/{event['id']}/convert-to-task", headers=auth(tokens)
    ).json()["data"]
    assert task["title"] == "改成待办"
    assert task["status"] == "TODO"
    assert range_query(client, tokens, "2026-10-05T00:00:00+08:00", "2026-10-06T00:00:00+08:00") == []


def admin_login(client) -> str:
    response = client.post(
        "/api/v1/admin/auth/login", json={"username": "admin", "password": "admin123456"}
    ).json()
    assert response["code"] == 0, response
    return response["data"]["accessToken"]


def admin_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def create_org(client, token: str, code: str, admin_username: str) -> int:
    created = client.post(
        "/api/v1/admin/organizations",
        json={
            "name": f"组织{code}",
            "code": code,
            "adminUsername": admin_username,
            "adminPassword": "pyadmin123",
        },
        headers=admin_headers(token),
    ).json()
    assert created["code"] == 0, created
    return created["data"]["id"]


def test_admin_creates_organization_with_first_admin(client) -> None:
    org_id = create_org(client, admin_login(client), "PYORG", "py_org_admin")
    assert org_id > 0
    login = client.post(
        "/api/v1/admin/auth/login", json={"username": "py_org_admin", "password": "pyadmin123"}
    ).json()
    assert login["code"] == 0
    # 组织管理员不是超管，不能访问组织管理接口
    forbidden = client.get(
        "/api/v1/admin/organizations", headers=admin_headers(login["data"]["accessToken"])
    ).json()
    assert forbidden["code"] == 20003


def seed_root_department(db, org_id: int) -> int:
    root = db.execute(
        "INSERT INTO department (org_id, name, path, level)"
        " VALUES (%s, '总部', '/0/', 1) RETURNING id",
        (org_id,),
    ).fetchone()[0]
    db.execute("UPDATE department SET path = '/' || id || '/' WHERE id = %s", (root,))
    return root


def seed_org_member(db, org_id: int, root: int, phone: str, role: str = "OWNER") -> str:
    """造一条「管理员刚导入、还没人认领」的成员记录（spec §3.1），返回成员唯一识别 ID。

    唯一识别 ID 直接用手机号后 4 位拼一个：测试里既能对上人，也能当学号/工号用。
    注意这里**不建账号、不建身份**——身份要等成员自己认领组织账号时才产生。
    """
    member_key = f"M{phone[-4:]}"
    query = (
        "INSERT INTO org_member (org_id, department_id, member_key, real_name, org_role, status)"
        " VALUES (%s, %s, %s, %s, %s, 'ACTIVE')"
    )
    db.execute(query, (org_id, root, member_key, f"成员{phone[-4:]}", role))
    return member_key


def claim_org_account(client, tokens: dict, org_id: int, member_key: str) -> dict:
    """用「组织唯一 ID + 成员唯一识别 ID」认领组织账号，返回该组织身份的授权头（spec §3.2）。"""
    linked = client.post(
        "/api/v1/org-accounts/login",
        params={"deviceId": "device-org"},
        json={"org": str(org_id), "memberKey": member_key},
        headers=auth(tokens),
    ).json()
    assert linked["code"] == 0, linked
    return {"Authorization": f"Bearer {linked['data']['accessToken']}"}


def add_member(client, headers: dict, member_key: str, name: str, department_id: int) -> int:
    """新增成员：只写成员唯一识别 ID（spec §3.1）。"""
    response = client.post(
        "/api/v1/org-admin/members",
        json={"memberKey": member_key, "realName": name, "departmentId": department_id},
        headers=headers,
    ).json()
    assert response["code"] == 0, response
    return response["data"]["id"]


def test_department_level_limit(client, db) -> None:
    org_id = create_org(client, admin_login(client), "PYLVL", "py_lvl_admin")
    root = seed_root_department(db, org_id)
    member_key = seed_org_member(db, org_id, root, "13900002010")
    headers = claim_org_account(client, register(client, "13900002010"), org_id, member_key)

    parent = root
    for level in range(2, 6):
        created = client.post(
            "/api/v1/org-admin/departments",
            json={"parentId": parent, "name": f"L{level}"},
            headers=headers,
        ).json()
        assert created["code"] == 0, created
        assert created["data"]["level"] == level
        parent = created["data"]["id"]
    rejected = client.post(
        "/api/v1/org-admin/departments",
        json={"parentId": parent, "name": "L6"},
        headers=headers,
    ).json()
    assert rejected["code"] == 40001


def test_department_manager_scope_is_recursive(client, db) -> None:
    org_id = create_org(client, admin_login(client), "PYSCOPE", "py_scope_admin")
    root = seed_root_department(db, org_id)
    owner_key = seed_org_member(db, org_id, root, "13900002030")
    headers = claim_org_account(client, register(client, "13900002030"), org_id, owner_key)

    def make_department(parent: int, name: str) -> int:
        return client.post(
            "/api/v1/org-admin/departments",
            json={"parentId": parent, "name": name},
            headers=headers,
        ).json()["data"]["id"]

    tech = make_department(root, "技术中心")
    backend = make_department(tech, "后端组")
    market = make_department(root, "市场部")

    tech_admin = add_member(client, headers, "13900002031", "技术负责人", tech)
    client.post(
        f"/api/v1/org-admin/departments/{tech}/managers",
        json={"orgMemberId": tech_admin},
        headers=headers,
    )
    add_member(client, headers, "13900002032", "后端同学", backend)
    add_member(client, headers, "13900002033", "市场同学", market)

    tech_headers = claim_org_account(client, register(client, "13900002031"), org_id, "13900002031")
    current = client.get("/api/v1/org/current", headers=tech_headers).json()["data"]
    assert current["orgAdmin"] is False
    # 权限范围 = 技术中心 + 后端组，不含市场部
    assert sorted(current["manageableDepartmentIds"]) == sorted([tech, backend])

    visible = client.get("/api/v1/org-admin/members", headers=tech_headers).json()["data"]
    assert sorted(item["realName"] for item in visible) == ["后端同学", "技术负责人"]

    base_event = {
        "startAt": "2026-10-08T09:00:00+08:00",
        "endAt": "2026-10-08T11:00:00+08:00",
        "scopeType": "DEPARTMENT",
    }
    ok = client.post(
        "/api/v1/org-admin/events",
        json={**base_event, "title": "技术中心周会", "departmentId": tech},
        headers=tech_headers,
    ).json()
    assert ok["code"] == 0, ok
    denied = client.post(
        "/api/v1/org-admin/events",
        json={**base_event, "title": "市场部会议", "departmentId": market},
        headers=tech_headers,
    ).json()
    assert denied["code"] == 20003


def test_dispatch_snapshot_excludes_new_members(client, db) -> None:
    org_id = create_org(client, admin_login(client), "PYSNAP", "py_snap_admin")
    root = seed_root_department(db, org_id)
    owner_key = seed_org_member(db, org_id, root, "13900002040")
    headers = claim_org_account(client, register(client, "13900002040"), org_id, owner_key)

    add_member(client, headers, "13900002041", "老成员", root)
    dispatched = client.post(
        "/api/v1/org-admin/events",
        json={
            "title": "历史全员会",
            "startAt": "2026-10-08T09:00:00+08:00",
            "endAt": "2026-10-08T11:00:00+08:00",
            "scopeType": "ALL",
            "requireReceipt": True,
        },
        headers=headers,
    ).json()
    assert dispatched["code"] == 0, dispatched

    # 下发之后加入的新成员不应补收历史日程
    add_member(client, headers, "13900002042", "新成员", root)
    window = {"start": "2026-10-01T00:00:00+08:00", "end": "2026-11-01T00:00:00+08:00"}
    new_headers = claim_org_account(client, register(client, "13900002042"), org_id, "13900002042")
    assert client.get("/api/v1/org/events", params=window, headers=new_headers).json()["data"] == []

    # 老成员能看到并提交回执
    old_headers = claim_org_account(client, register(client, "13900002041"), org_id, "13900002041")
    old_events = client.get("/api/v1/org/events", params=window, headers=old_headers).json()["data"]
    assert len(old_events) == 1
    receipt = client.post(
        f"/api/v1/org/events/{old_events[0]['eventId']}/receipt",
        json={"status": "ACCEPTED", "remark": "准时参加"},
        headers=old_headers,
    ).json()
    assert receipt["code"] == 0, receipt
    assert receipt["data"]["receiptStatus"] == "ACCEPTED"


def test_org_account_claim_list_and_unlink(client, db) -> None:
    """组织账号的认领 / 列表 / 解绑（spec §3.1 / §3.2 / §4.2.5）。"""
    org_id = create_org(client, admin_login(client), "PYCLAIM", "py_claim_admin")
    root = seed_root_department(db, org_id)
    member_key = seed_org_member(db, org_id, root, "13900002050")
    tokens = register(client, "13900002050")

    # 认领前：列表为空，成员记录还没有组织身份（身份由认领产生，不由管理员预建）
    assert client.get("/api/v1/org-accounts", headers=auth(tokens)).json()["data"] == []
    assert (
        db.execute(
            "SELECT identity_id FROM org_member WHERE org_id = %s AND member_key = %s",
            (org_id, member_key),
        ).fetchone()[0]
        is None
    )

    # 用组织编码认领（数字 ID 也认，见 Java 侧对齐的实现）
    linked = client.post(
        "/api/v1/org-accounts/login",
        params={"deviceId": "device-1"},
        json={"org": "PYCLAIM", "memberKey": member_key},
        headers=auth(tokens),
    ).json()
    assert linked["code"] == 0, linked
    account = linked["data"]["account"]
    assert account["orgCode"] == "PYCLAIM"
    assert account["memberKey"] == member_key
    org_headers = {"Authorization": f"Bearer {linked['data']['accessToken']}"}
    assert client.get("/api/v1/org/current", headers=org_headers).json()["code"] == 0

    listed = client.get("/api/v1/org-accounts", headers=auth(tokens)).json()["data"]
    assert [item["identityId"] for item in listed] == [account["identityId"]]
    assert listed[0]["lastLoginAt"] is not None

    # 重复认领是幂等的：不产生第二条身份
    again = client.post(
        "/api/v1/org-accounts/login",
        params={"deviceId": "device-1"},
        json={"org": "PYCLAIM", "memberKey": member_key},
        headers=auth(tokens),
    ).json()
    assert again["code"] == 0
    assert again["data"]["account"]["identityId"] == account["identityId"]
    assert (
        db.execute(
            "SELECT count(*) FROM identity WHERE account_id ="
            " (SELECT account_id FROM identity WHERE id = %s) AND org_id = %s",
            (account["identityId"], org_id),
        ).fetchone()[0]
        == 1
    )

    # 已被认领的组织账号：别的个人账号认领会被拒（否则报出学号就能顶掉别人）
    other = register(client, "13900002051")
    denied = client.post(
        "/api/v1/org-accounts/login",
        params={"deviceId": "device-2"},
        json={"org": str(org_id), "memberKey": member_key},
        headers=auth(other),
    ).json()
    assert denied["code"] == 20003

    # 同一个个人账号在同一组织只能绑一个成员账号：再认领另一个成员要被明确拒绝
    another_key = seed_org_member(db, org_id, root, "13900002053", role="MEMBER")
    same_account = client.post(
        "/api/v1/org-accounts/login",
        params={"deviceId": "device-1"},
        json={"org": str(org_id), "memberKey": another_key},
        headers=auth(tokens),
    ).json()
    assert same_account["code"] == 20003
    assert "已绑定成员" in same_account["message"]

    # 但同组织里的另一个成员照样能认领：绑定是按成员隔离的
    # （角色给 MEMBER：一个组织只能有一个 OWNER，那是唯一约束）
    other_key = seed_org_member(db, org_id, root, "13900002052", role="MEMBER")
    assert (
        client.post(
            "/api/v1/org-accounts/login",
            params={"deviceId": "device-2"},
            json={"org": str(org_id), "memberKey": other_key},
            headers=auth(other),
        ).json()["code"]
        == 0
    )
    assert len(client.get("/api/v1/org-accounts", headers=auth(other)).json()["data"]) == 1

    # 解绑：登录记录消失、组织视图不可用、成员记录保留且回到未认领状态
    assert (
        client.delete(
            f"/api/v1/org-accounts/{account['identityId']}", headers=auth(tokens)
        ).json()["code"]
        == 0
    )
    assert client.get("/api/v1/org-accounts", headers=auth(tokens)).json()["data"] == []
    assert client.get("/api/v1/org/current", headers=org_headers).json()["code"] != 0
    assert (
        db.execute(
            "SELECT identity_id FROM org_member WHERE org_id = %s AND member_key = %s",
            (org_id, member_key),
        ).fetchone()[0]
        is None
    )

    # 解绑后可以用同样的凭据重新认领（复用原身份，不会撞唯一键）
    reclaimed = client.post(
        "/api/v1/org-accounts/login",
        params={"deviceId": "device-1"},
        json={"org": "PYCLAIM", "memberKey": member_key},
        headers=auth(tokens),
    ).json()
    assert reclaimed["code"] == 0
    assert reclaimed["data"]["account"]["identityId"] == account["identityId"]


def test_admin_can_unbind_member_account(client, db) -> None:
    """组织管理员解绑成员的组织账号：成员换号或被冒领后的恢复路径（spec §6.3）。"""
    org_id = create_org(client, admin_login(client), "PYADMUNB", "py_admunb_admin")
    root = seed_root_department(db, org_id)
    owner_key = seed_org_member(db, org_id, root, "13900002060")
    owner_tokens = register(client, "13900002060")
    owner_headers = claim_org_account(client, owner_tokens, org_id, owner_key)
    member_id = db.execute(
        "SELECT id FROM org_member WHERE org_id = %s AND member_key = %s", (org_id, owner_key)
    ).fetchone()[0]

    unbound = client.post(
        f"/api/v1/org-admin/members/{member_id}/unbind", headers=owner_headers
    ).json()

    assert unbound["code"] == 0, unbound
    assert unbound["data"]["bound"] is False
    assert unbound["data"]["memberKey"] == owner_key
    assert client.get("/api/v1/org-accounts", headers=auth(owner_tokens)).json()["data"] == []


def dispatch_to_all(client, headers: dict, title: str) -> int:
    """组织管理员把一条日程下发给全组织，返回 eventId。"""
    response = client.post(
        "/api/v1/org-admin/events",
        json={
            "title": title,
            "startAt": "2026-10-08T09:00:00+08:00",
            "endAt": "2026-10-08T11:00:00+08:00",
            "scopeType": "ALL",
        },
        headers=headers,
    ).json()
    assert response["code"] == 0, response
    return response["data"]["eventId"]


def test_search_covers_org_events_across_bound_organizations(client, db) -> None:
    """检索覆盖「我绑定的所有组织」的组织日程；撤回的下发不再出现（spec §4.1.7）。"""
    admin = admin_login(client)
    first_org = create_org(client, admin, "PYSRCHA", "py_srcha_admin")
    first_root = seed_root_department(db, first_org)
    first_key = seed_org_member(db, first_org, first_root, "13900002501")
    tokens = register(client, "13900002501")
    first_headers = claim_org_account(client, tokens, first_org, first_key)

    # 第二个组织的成员用**同一个个人账号**认领：一个人可以绑多个组织
    second_org = create_org(client, admin, "PYSRCHB", "py_srchb_admin")
    second_root = seed_root_department(db, second_org)
    second_key = seed_org_member(db, second_org, second_root, "13900002502")
    second_headers = claim_org_account(client, tokens, second_org, second_key)

    dispatch_to_all(client, first_headers, "季度技术评审会")
    second_event = dispatch_to_all(client, second_headers, "评审会材料准备")

    # 用**个人令牌**搜：要能搜到所有已绑定组织的日程，不必先切组织
    hits = search(client, tokens, "评审会")
    assert {item["type"] for item in hits} == {"ORG_EVENT"}
    assert {item["orgName"] for item in hits} == {"组织PYSRCHA", "组织PYSRCHB"}
    assert all(item["identityId"] for item in hits), "组织日程要带回身份，App 才能切到对应组织"

    # 撤回第二条下发：它不该再出现在检索结果里（否则点开是空的）
    assert (
        client.post(
            f"/api/v1/org-admin/events/{second_event}/revoke", headers=second_headers
        ).json()["code"]
        == 0
    )
    after = search(client, tokens, "评审会")
    assert [item["orgName"] for item in after] == ["组织PYSRCHA"]


def test_org_console_token_can_open_up_a_new_organization(client, db) -> None:
    """组织管理端：后台 ORG_ADMIN 令牌就能给**全新组织**建部门、导成员、下发日程（spec §4.3）。

    这正是原来「新组织一个成员都没有，于是没人能导入首位成员」的那个死循环。
    """
    create_org(client, admin_login(client), "PYCONSOLE", "py_console_admin")
    console = admin_headers(
        client.post(
            "/api/v1/admin/auth/login",
            json={"username": "py_console_admin", "password": "pyadmin123"},
        ).json()["data"]["accessToken"]
    )

    settings = client.get("/api/v1/org-admin/settings", headers=console).json()
    assert settings["code"] == 0, settings
    assert settings["data"]["code"] == "PYCONSOLE"
    assert settings["data"]["memberCount"] == 0

    created = client.post(
        "/api/v1/org-admin/departments", json={"name": "总部"}, headers=console
    ).json()
    assert created["code"] == 0, created
    root = created["data"]["id"]

    single = client.post(
        "/api/v1/org-admin/members",
        json={"memberKey": "P1001", "realName": "王小明", "departmentId": root},
        headers=console,
    ).json()
    assert single["code"] == 0, single

    csv = "姓名,成员唯一识别 ID（学号/工号）,部门路径,角色\n李四,P1002,总部,MEMBER\n".encode()
    imported = client.post(
        "/api/v1/org-admin/members/import",
        files={"file": ("members.csv", csv, "text/csv")},
        headers=console,
    ).json()
    assert imported["code"] == 0, imported
    assert imported["data"]["successCount"] == 1

    members = client.get("/api/v1/org-admin/members", headers=console).json()["data"]
    assert sorted(item["realName"] for item in members) == ["李四", "王小明"]
    assert client.get("/api/v1/org-admin/settings", headers=console).json()["data"]["memberCount"] == 2

    updated = client.patch(
        "/api/v1/org-admin/settings",
        json={"name": "控制台组织（改）", "contactName": "前台", "timezone": "Asia/Shanghai"},
        headers=console,
    ).json()
    assert updated["data"]["name"] == "控制台组织（改）"
    assert updated["data"]["contactName"] == "前台"

    # 导进来的成员能认领组织账号 —— 闭环的另一半
    org_id = db.execute(
        "SELECT id FROM organization WHERE code = %s", ("PYCONSOLE",)
    ).fetchone()[0]
    member_headers = claim_org_account(client, register(client, "13900003001"), org_id, "P1002")
    assert (
        client.get("/api/v1/org/current", headers=member_headers).json()["data"]["realName"] == "李四"
    )

    # 后台下发组织日程：没有 C 端身份，发起方落在 created_by_admin_id（spec §5.6）
    dispatched = client.post(
        "/api/v1/org-admin/events",
        json={
            "title": "新组织第一场会",
            "startAt": "2026-10-08T09:00:00+08:00",
            "endAt": "2026-10-08T11:00:00+08:00",
            "scopeType": "ALL",
            "requireReceipt": True,
        },
        headers=console,
    ).json()
    assert dispatched["code"] == 0, dispatched

    events = client.get(
        "/api/v1/org-admin/events",
        params={"start": "2026-10-01T00:00:00+08:00", "end": "2026-11-01T00:00:00+08:00"},
        headers=console,
    ).json()["data"]
    assert len(events) == 1
    assert events[0]["title"] == "新组织第一场会"
    assert events[0]["recipientCount"] == 2
    assert events[0]["pendingCount"] == 2
    event_id = events[0]["eventId"]
    assert db.execute(
        "SELECT creator_identity_id FROM event WHERE id = %s", (event_id,)
    ).fetchone()[0] is None
    assert db.execute(
        "SELECT created_by_admin_id FROM event_dispatch WHERE event_id = %s", (event_id,)
    ).fetchone()[0] is not None

    # 部门树与操作日志都是真实数据（spec §4.3）
    tree = client.get("/api/v1/org-admin/departments", headers=console).json()["data"]
    assert any(node["name"] == "总部" for node in tree)
    actions = {
        row["action"]
        for row in client.get("/api/v1/org-admin/logs", headers=console).json()["data"]
    }
    assert {
        "ORG_DEPARTMENT_CREATE",
        "ORG_MEMBER_CREATE",
        "ORG_MEMBER_IMPORT",
        "ORG_EVENT_DISPATCH",
        "ORG_SETTINGS_UPDATE",
    } <= actions


def test_org_console_token_is_scoped_and_member_is_rejected(client, db) -> None:
    """后台令牌只作用于自己那个组织；普通成员的组织身份令牌不能调管理端接口（spec §2.2）。"""
    super_token = admin_login(client)
    org_a = create_org(client, super_token, "PYSCOPEA", "py_scope_a")
    org_b = create_org(client, super_token, "PYSCOPEB", "py_scope_b")
    root_b = seed_root_department(db, org_b)
    member_b = db.execute(
        "INSERT INTO org_member (org_id, department_id, member_key, real_name, org_role, status)"
        " VALUES (%s, %s, 'PB1001', 'B组织成员', 'MEMBER', 'ACTIVE') RETURNING id",
        (org_b, root_b),
    ).fetchone()[0]

    console_a = admin_headers(
        client.post(
            "/api/v1/admin/auth/login",
            json={"username": "py_scope_a", "password": "pyadmin123"},
        ).json()["data"]["accessToken"]
    )
    assert client.get("/api/v1/org-admin/members", headers=console_a).json()["data"] == []
    denied = client.patch(
        f"/api/v1/org-admin/members/{member_b}", json={"realName": "越权改名"}, headers=console_a
    ).json()
    assert denied["code"] == 20003, denied

    # 组织身份的普通成员：能看组织日历，但不能碰管理端接口
    root_a = client.post(
        "/api/v1/org-admin/departments", json={"name": "总部"}, headers=console_a
    ).json()["data"]["id"]
    client.post(
        "/api/v1/org-admin/members",
        json={"memberKey": "PA2001", "realName": "甲成员", "departmentId": root_a},
        headers=console_a,
    )
    member_headers = claim_org_account(client, register(client, "13900003002"), org_a, "PA2001")
    csv = "姓名,成员唯一识别 ID（学号/工号）,部门路径,角色\n小兵,PA2002,总部,MEMBER\n".encode()
    forbidden = client.post(
        "/api/v1/org-admin/members/import",
        files={"file": ("members.csv", csv, "text/csv")},
        headers=member_headers,
    ).json()
    assert forbidden["code"] == 20003, forbidden
