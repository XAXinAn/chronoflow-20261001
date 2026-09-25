"""个人 / 组织 / 超管三个模块的关键行为（与 Java 版测试覆盖同一批语义）。"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

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
