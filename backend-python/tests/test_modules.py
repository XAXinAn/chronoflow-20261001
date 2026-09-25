"""个人 / 组织 / 超管三个模块的关键行为（与 Java 版测试覆盖同一批语义）。"""

from __future__ import annotations

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
    assert len(whole_year["days"]) == 3
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


def seed_org_member(db, org_id: int, root: int, phone: str, role: str = "OWNER") -> int:
    account = db.execute("INSERT INTO account (phone) VALUES (%s) RETURNING id", (phone,)).fetchone()[0]
    identity = db.execute(
        "INSERT INTO identity (account_id, identity_type, org_id, nickname)"
        " VALUES (%s, 'ORG_MEMBER', %s, %s) RETURNING id",
        (account, org_id, phone),
    ).fetchone()[0]
    db.execute(
        "INSERT INTO org_member (org_id, identity_id, department_id, real_name, org_role, member_no)"
        " VALUES (%s, %s, %s, %s, %s, %s)",
        (org_id, identity, root, f"成员{phone[-4:]}", role, f"M{phone[-4:]}"),
    )
    return identity


def login_org_identity(client, db, org_id: int, phone: str, identity: int) -> dict:
    code = send_code(client, phone)
    select_token = client.post(
        "/api/v1/auth/login/sms", json={"phone": phone, "code": code}
    ).json()["data"]["selectToken"]
    selected = client.post(
        "/api/v1/auth/identity/select",
        json={"selectToken": select_token, "identityId": identity, "deviceId": "d"},
    ).json()
    assert selected["code"] == 0, selected
    return {"Authorization": f"Bearer {selected['data']['accessToken']}"}


def find_identity(db, org_id: int, phone: str) -> int:
    return db.execute(
        "SELECT id FROM identity WHERE account_id = (SELECT id FROM account WHERE phone = %s)"
        " AND org_id = %s",
        (phone, org_id),
    ).fetchone()[0]


def add_member(client, headers: dict, phone: str, name: str, department_id: int) -> int:
    response = client.post(
        "/api/v1/org-admin/members",
        json={"phone": phone, "realName": name, "departmentId": department_id},
        headers=headers,
    ).json()
    assert response["code"] == 0, response
    return response["data"]["id"]


def test_department_level_limit(client, db) -> None:
    org_id = create_org(client, admin_login(client), "PYLVL", "py_lvl_admin")
    root = seed_root_department(db, org_id)
    identity = seed_org_member(db, org_id, root, "13900002010")
    headers = login_org_identity(client, db, org_id, "13900002010", identity)

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
    owner_identity = seed_org_member(db, org_id, root, "13900002030")
    headers = login_org_identity(client, db, org_id, "13900002030", owner_identity)

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

    tech_headers = login_org_identity(
        client, db, org_id, "13900002031", find_identity(db, org_id, "13900002031")
    )
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
    owner_identity = seed_org_member(db, org_id, root, "13900002040")
    headers = login_org_identity(client, db, org_id, "13900002040", owner_identity)

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
    new_headers = login_org_identity(
        client, db, org_id, "13900002042", find_identity(db, org_id, "13900002042")
    )
    assert client.get("/api/v1/org/events", params=window, headers=new_headers).json()["data"] == []

    # 老成员能看到并提交回执
    old_headers = login_org_identity(
        client, db, org_id, "13900002041", find_identity(db, org_id, "13900002041")
    )
    old_events = client.get("/api/v1/org/events", params=window, headers=old_headers).json()["data"]
    assert len(old_events) == 1
    receipt = client.post(
        f"/api/v1/org/events/{old_events[0]['eventId']}/receipt",
        json={"status": "ACCEPTED", "remark": "准时参加"},
        headers=old_headers,
    ).json()
    assert receipt["code"] == 0, receipt
    assert receipt["data"]["receiptStatus"] == "ACCEPTED"
