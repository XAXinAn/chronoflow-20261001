"""测试基础设施。

真实启动 PostgreSQL 与 Redis（而非替身），因为本项目的核心行为——令牌轮换、
验证码频控、JSONB 写入——都依赖真实实现。

schema 由 **Flyway 迁移文件**直接应用，与 Java 版共用同一份 DDL，
不存在「两边各写一套建表语句然后慢慢漂移」的可能。
"""

from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_DIR = (
    REPO_ROOT / "backend-java" / "xa-bootstrap" / "src" / "main" / "resources" / "db" / "migration"
)


def _find_pg_bin() -> str:
    explicit = os.getenv("XA_TODO_PG_BIN")
    if explicit:
        return explicit
    on_path = shutil.which("pg_ctl")
    if on_path:
        return str(Path(on_path).parent)
    cached = Path.home() / ".cache" / "xa-todo" / "pg" / "bin"
    if (cached / "pg_ctl").exists():
        return str(cached)
    pytest.fail(
        "找不到 PostgreSQL 二进制。请执行 backend-python/scripts/setup-test-deps.sh，"
        "或设置 XA_TODO_PG_BIN，或在 CI 上安装 postgresql。"
    )


def _find_redis_bin() -> str:
    explicit = os.getenv("XA_TODO_REDIS_BIN")
    if explicit:
        return explicit
    cached = Path.home() / ".cache" / "xa-todo" / "redis" / "redis-server"
    if cached.exists():
        return str(cached)
    on_path = shutil.which("redis-server")
    if on_path:
        return on_path
    pytest.fail("找不到 redis-server。请执行 backend-python/scripts/setup-test-deps.sh。")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_redis(port: int, timeout: float = 15.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("Redis 未在预期时间内启动")


@pytest.fixture(scope="session")
def databases() -> Iterator[dict[str, str]]:
    pg_bin = _find_pg_bin()
    data_dir = tempfile.mkdtemp(prefix="xa-pg-")
    # 用 unix socket 目录而不是 TCP 端口，避免与机器上其他服务抢占端口
    socket_dir = data_dir

    subprocess.run(
        [f"{pg_bin}/initdb", "-D", data_dir, "-U", "postgres", "--auth=trust", "-E", "UTF8"],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            f"{pg_bin}/pg_ctl",
            "-D",
            data_dir,
            "-o",
            f"-k {socket_dir}",
            "-l",
            f"{data_dir}/pg.log",
            "-w",
            "start",
        ],
        check=True,
        capture_output=True,
    )

    try:
        # zonky 的发行版只含服务端工具，没有 createdb/psql，因此用 psycopg 建库
        import psycopg

        with psycopg.connect(
            f"postgresql://postgres@/postgres?host={socket_dir}", autocommit=True
        ) as conn:
            conn.execute("CREATE DATABASE xatodo")
        dsn = f"postgresql://postgres@/xatodo?host={socket_dir}"
        _apply_migrations(dsn)

        redis_port = _free_port()
        redis_proc = subprocess.Popen(
            [_find_redis_bin(), "--port", str(redis_port), "--save", "", "--appendonly", "no"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _wait_for_redis(redis_port)

        # 环境变量必须在导入 app 之前设置：app.config 在导入时就读取环境
        os.environ["DATABASE_URL"] = "postgresql+psycopg://" + dsn.split("://", 1)[1]
        os.environ["REDIS_URL"] = f"redis://127.0.0.1:{redis_port}/0"
        os.environ["EXPOSE_SMS_CODE"] = "true"
        # 按 IP 的验证码日限额在测试里没有意义：TestClient 的 client_ip 恒为 "testclient"，
        # 于是**整个套件**共用一个计数器，用例一多就会随机变红（表现为无关用例报「发送次数已达上限」）。
        # 手机号维度的限额保持原样，它才是测试真正会碰到的那个。
        os.environ["SMS_DAILY_LIMIT_PER_IP"] = "100000"
        # 测试不依赖外网：关掉节假日自动同步（真实环境默认开启，见 app/config.py）
        os.environ["HOLIDAY_SYNC_ENABLED"] = "false"
        # 上传目录指向临时目录：测试不该往仓库里写图片
        os.environ["XATODO_UPLOAD_DIR"] = tempfile.mkdtemp(prefix="xa-uploads-")

        try:
            yield {"dsn": dsn}
        finally:
            redis_proc.terminate()
            redis_proc.wait(timeout=10)
    finally:
        subprocess.run(
            [f"{pg_bin}/pg_ctl", "-D", data_dir, "-m", "immediate", "stop"],
            capture_output=True,
        )


def _apply_migrations(dsn: str) -> None:
    import psycopg

    # 按版本号**数值**排序，与 Flyway 一致。
    # 直接 sorted() 是字典序，V10__ 会排在 V4__ 前面，于是「在 task 表还不存在时
    # 就执行 ALTER TABLE task」——这个坑只在加了两位数版本号之后才会暴露。
    files = sorted(MIGRATION_DIR.glob("V*__*.sql"), key=_migration_version)
    assert files, f"未找到迁移文件: {MIGRATION_DIR}"
    with psycopg.connect(dsn, autocommit=True) as conn:
        for path in files:
            conn.execute(path.read_text(encoding="utf-8"))


def _migration_version(path) -> int:
    matched = re.match(r"V(\d+)__", path.name)
    return int(matched.group(1)) if matched else 0


@pytest.fixture(scope="session")
def client(databases):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def db(databases):
    import psycopg

    with psycopg.connect(databases["dsn"], autocommit=True) as conn:
        yield conn
