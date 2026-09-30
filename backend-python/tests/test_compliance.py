"""上架合规的端到端验收（与 Java 版 ComplianceTest 覆盖同一批语义）。

对应应用宝《隐私政策提交内容及审核规范》里两条只能在服务端验证的要求：
  1. 隐私政策等合规文本必须有公开、免登录、纯静态的地址（规范 §一）；
  2. 账号注销必须真的「删除或匿名化」（规范 §2.7）。
"""

from __future__ import annotations

from test_auth_flow import auth, register

# 注意：**不要**在模块顶层 import app.* —— conftest 是在 databases fixture 里才设置
# DATABASE_URL / REDIS_URL 的，而 `app.config` 在导入时就读环境变量、`app.db` 在导入时就建引擎。
# 顶层导入会把配置冻在「本地默认值」上，整个测试会话都会去打开发机上那台真实的 PostgreSQL。
# 需要 app 里的东西时，在函数内部 import。

# 营业执照上的主体名称，必须与 docs/legal/privacy-policy.md 一致（规范 §2.2）
OPERATOR = "舟山市时纪云人工智能应用软件开发有限公司"


def test_legal_documents_are_public_and_static(client) -> None:
    """免登录可直接抓取，且页面里没有脚本（规范 §一-2②）。"""
    from app.services.legal import LEGAL_DOCUMENTS

    for slug in LEGAL_DOCUMENTS:
        response = client.get(f"/api/v1/legal/{slug}")
        assert response.status_code == 200, slug
        assert response.headers["content-type"].startswith("text/html"), slug
        assert "<html" in response.text
        assert "<script" not in response.text.lower(), slug

    policy = client.get("/api/v1/legal/privacy-policy").text
    assert OPERATOR in policy
    # 规范 §2.7：注销步骤必须写出来，且路径与 App 内真实入口一致
    assert "账号注销" in policy
    assert "我的 → 隐私与合规 → 账号注销" in policy
    # 规范 §2.8：不做个性化推送就必须明说
    assert "不提供个性化推荐" in policy

    assert client.get("/api/v1/legal/not-a-document").status_code == 404


def test_deletion_requires_login(client) -> None:
    response = client.post("/api/v1/me/deletion")
    assert response.status_code == 401
    assert response.json()["code"] == 20001


def test_self_service_deletion_purges_personal_data(client) -> None:
    """注销后：个人信息删除 / 匿名化、组织解绑、手机号释放、令牌当场失效。"""
    # 用没被其它用例占用的号段：默认 60 秒的「同手机号发码间隔」是跨用例共享的 Redis 键，
    # 撞号会让后跑的用例莫名其妙地报「验证码发送过于频繁」
    phone = "13900009001"
    tokens = register(client, phone, "要注销的人")
    identity_id = tokens["identity"]["identityId"]

    from test_modules import create_event

    create_event(
        client,
        tokens,
        {
            "title": "要消失的日程",
            "at": "2026-10-01T09:00:00+08:00",
        },
    )
    task = client.post(
        "/api/v1/tasks", json={"title": "要消失的待办"}, headers=auth(tokens)
    ).json()
    assert task["code"] == 0, task

    deleted = client.post("/api/v1/me/deletion", headers=auth(tokens)).json()
    assert deleted["code"] == 0, deleted

    # 1) 访问令牌当场失效：无状态 JWT 光靠吊销刷新令牌只断掉续期，所以服务端另打了作废标记
    after = client.get("/api/v1/me", headers=auth(tokens))
    assert after.status_code == 401
    assert after.json()["code"] == 20008

    from sqlalchemy import text

    from app.db import SessionLocal

    with SessionLocal() as session:

        row = session.execute(
            text(
                "SELECT a.phone, a.status, a.password_hash IS NULL AS no_password,"
                " i.status AS identity_status, i.nickname"
                " FROM account a JOIN identity i ON i.account_id = a.id"
                " WHERE i.id = :identity_id"
            ),
            {"identity_id": identity_id},
        ).mappings().one()
        # 2) 账号被匿名化：手机号释放、密码清空、状态停用
        assert row["phone"].startswith("deleted-")
        assert row["status"] == "DISABLED"
        assert row["no_password"] is True
        # 3) 个人身份停用并抹掉昵称
        assert row["identity_status"] == "DISABLED"
        assert row["nickname"] == "已注销用户"

        # 4) 个人数据被物理删除
        for table, column in (
            ("event", "creator_identity_id"),
            ("task", "owner_identity_id"),
            ("calendar", "owner_identity_id"),
        ):
            remaining = session.execute(
                text(f"SELECT count(*) FROM {table} WHERE {column} = :identity_id"),
                {"identity_id": identity_id},
            ).scalar_one()
            assert remaining == 0, table

    # 5) 手机号真的被释放：同一个号可以重新注册成一个全新账号。
    #    这里直接往 Redis 里注入验证码而不是再发一条——同一手机号 60 秒内只能发一次码（spec §3.6）。
    from app.wiring import _code_store

    _code_store().save_code(phone, "654321", 300)
    relogin = client.post(
        "/api/v1/auth/login/sms", json={"phone": phone, "code": "654321", "deviceId": "device-9"}
    ).json()
    assert relogin["data"]["needRegister"] is True
