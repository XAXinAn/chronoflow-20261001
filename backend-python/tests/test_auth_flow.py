"""认证链路行为对齐（与 Java 版 AuthFlowTest 覆盖同一批语义）。"""

from __future__ import annotations


def send_code(client, phone: str) -> str:
    response = client.post("/api/v1/auth/sms/code", json={"phone": phone})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["code"] == 0, body
    return body["data"]["debugCode"]


def register(client, phone: str, nickname: str = "测试用户") -> dict:
    code = send_code(client, phone)
    # 登录必须带 deviceId：令牌与设备绑定（spec §3.5）
    login = client.post(
        "/api/v1/auth/login/sms", json={"phone": phone, "code": code, "deviceId": "device-1"}
    ).json()
    assert login["data"]["needRegister"] is True, login
    register_token = login["data"]["registerToken"]
    created = client.post(
        "/api/v1/identities/personal",
        json={"nickname": nickname, "deviceId": "device-1"},
        headers={"Authorization": f"Bearer {register_token}"},
    ).json()
    assert created["code"] == 0, created
    return created["data"]


def auth(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['accessToken']}"}


def test_unauthenticated_request_returns_envelope(client) -> None:
    response = client.get("/api/v1/me")
    assert response.status_code == 401
    body = response.json()
    assert body["code"] == 20001
    assert body["traceId"]


def test_full_registration_flow(client) -> None:
    tokens = register(client, "13900001001", "小明")
    assert tokens["identity"]["identityType"] == "PERSONAL"

    me = client.get("/api/v1/me", headers=auth(tokens)).json()
    assert me["code"] == 0
    assert me["data"]["nickname"] == "小明"

    identities = client.get("/api/v1/auth/identities", headers=auth(tokens)).json()
    assert len(identities["data"]) == 1


def test_register_token_cannot_access_business_api(client) -> None:
    phone = "13900001002"
    code = send_code(client, phone)
    register_token = client.post(
        "/api/v1/auth/login/sms", json={"phone": phone, "code": code, "deviceId": "device-1"}
    ).json()["data"]["registerToken"]
    response = client.get("/api/v1/me", headers={"Authorization": f"Bearer {register_token}"})
    assert response.status_code == 401
    assert response.json()["code"] == 20001


def test_sms_send_is_rate_limited(client) -> None:
    phone = "13900001003"
    send_code(client, phone)
    again = client.post("/api/v1/auth/sms/code", json={"phone": phone}).json()
    assert again["code"] == 20005


def test_wrong_code_rejected(client) -> None:
    phone = "13900001004"
    send_code(client, phone)
    wrong = client.post(
        "/api/v1/auth/login/sms", json={"phone": phone, "code": "000000", "deviceId": "device-1"}
    ).json()
    assert wrong["code"] == 20006


def test_concurrent_refresh_is_idempotent(client) -> None:
    tokens = register(client, "13900001005")
    refresh_token = tokens["refreshToken"]
    first = client.post("/api/v1/auth/token/refresh", json={"refreshToken": refresh_token}).json()
    rotated = first["data"]["refreshToken"]
    assert rotated != refresh_token
    # 宽限期内重复提交旧令牌应拿回同一个新令牌，而不是把用户踢出登录
    second = client.post("/api/v1/auth/token/refresh", json={"refreshToken": refresh_token}).json()
    assert second["code"] == 0
    assert second["data"]["refreshToken"] == rotated


def test_logout_revokes_refresh_token(client) -> None:
    tokens = register(client, "13900001006")
    client.post("/api/v1/auth/logout", json={"refreshToken": tokens["refreshToken"]})
    after = client.post(
        "/api/v1/auth/token/refresh", json={"refreshToken": tokens["refreshToken"]}
    ).json()
    assert after["code"] == 20007


def test_password_set_and_login(client) -> None:
    tokens = register(client, "13900001007")
    headers = auth(tokens)
    assert client.put(
        "/api/v1/me/password", json={"newPassword": "mySecret123"}, headers=headers
    ).json()["code"] == 0
    login = client.post(
        "/api/v1/auth/login/password",
        json={"phone": "13900001007", "password": "mySecret123", "deviceId": "device-2"},
    ).json()
    # 登录只认个人身份：直接给出个人身份的令牌对，不再有选身份这一步（spec §3.2）
    assert login["data"]["needRegister"] is False
    assert login["data"]["session"]["identity"]["identityType"] == "PERSONAL"
    assert login["data"]["session"]["accessToken"]
    # 已有密码后，不带原密码再改密应被拒绝
    rejected = client.put(
        "/api/v1/me/password", json={"newPassword": "anotherPass123"}, headers=headers
    ).json()
    assert rejected["code"] == 10002


def test_device_list_and_revoke(client) -> None:
    tokens = register(client, "13900001008")
    headers = auth(tokens)
    devices = client.get("/api/v1/me/devices", headers=headers).json()["data"]
    assert len(devices) == 1
    assert devices[0]["deviceId"] == "device-1"
    assert client.delete("/api/v1/me/devices/device-1", headers=headers).json()["code"] == 0
    after = client.post(
        "/api/v1/auth/token/refresh", json={"refreshToken": tokens["refreshToken"]}
    ).json()
    assert after["code"] == 20007


def test_notification_prefs_roundtrip(client) -> None:
    tokens = register(client, "13900001009")
    saved = client.put(
        "/api/v1/me/notifications",
        json={"prefs": {"eventReminder": False, "orgDispatch": True}},
        headers=auth(tokens),
    ).json()
    assert saved["data"] == {"eventReminder": False, "orgDispatch": True}
