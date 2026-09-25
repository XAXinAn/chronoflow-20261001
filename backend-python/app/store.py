"""Redis 存储：验证码与刷新令牌。

**键规范与 Java 版逐字一致**（`sms:code:{phone}`、`rt:{tokenId}`、`rt:idx:i:{identityId}` …），
因此两版不仅令牌可互换，会话状态本身也是共享的——同一 Redis 下可以灰度切换后端。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass

import redis

from .config import settings

CODE_KEY = "sms:code:"
LOCK_KEY = "sms:lock:"
DAILY_KEY = "sms:daily:"
FAIL_KEY = "sms:fail:"

TOKEN_KEY = "rt:"
INDEX_IDENTITY = "rt:idx:i:"
INDEX_ACCOUNT = "rt:idx:a:"
SUCCESSOR_KEY = "rt:succ:"


def create_redis() -> redis.Redis:
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)


class VerificationCodeStore:
    def __init__(self, client: redis.Redis):
        self._redis = client

    def save_code(self, phone: str, code: str, ttl: int) -> None:
        self._redis.set(CODE_KEY + phone, code, ex=ttl)

    def find_code(self, phone: str) -> str | None:
        return self._redis.get(CODE_KEY + phone)

    def delete_code(self, phone: str) -> None:
        self._redis.delete(CODE_KEY + phone)

    def acquire_send_lock(self, phone: str, ttl: int) -> bool:
        return bool(self._redis.set(LOCK_KEY + phone, "1", ex=ttl, nx=True))

    def increment_daily(self, dimension: str, value: str, ttl: int) -> int:
        key = f"{DAILY_KEY}{dimension}:{value}"
        count = self._redis.incr(key)
        if count == 1:
            self._redis.expire(key, ttl)
        return int(count)

    def increment_verify_failure(self, phone: str, ttl: int) -> int:
        key = FAIL_KEY + phone
        count = self._redis.incr(key)
        if count == 1:
            self._redis.expire(key, ttl)
        return int(count)

    def clear_verify_failure(self, phone: str) -> None:
        self._redis.delete(FAIL_KEY + phone)


@dataclass(frozen=True)
class RefreshTokenRecord:
    token_id: str
    account_id: int
    identity_id: int
    device_id: str | None
    issued_at: float


class RefreshTokenStore:
    def __init__(self, client: redis.Redis):
        self._redis = client

    def save(self, record: RefreshTokenRecord, ttl: int) -> None:
        payload = json.dumps(
            {
                "tokenId": record.token_id,
                "accountId": record.account_id,
                "identityId": record.identity_id,
                "deviceId": record.device_id,
                "issuedAt": record.issued_at,
            }
        )
        score = record.issued_at * 1000
        pipe = self._redis.pipeline()
        pipe.set(TOKEN_KEY + record.token_id, payload, ex=ttl)
        pipe.zadd(INDEX_IDENTITY + str(record.identity_id), {record.token_id: score})
        pipe.expire(INDEX_IDENTITY + str(record.identity_id), ttl)
        pipe.zadd(INDEX_ACCOUNT + str(record.account_id), {record.token_id: score})
        pipe.expire(INDEX_ACCOUNT + str(record.account_id), ttl)
        pipe.execute()

    def find(self, token_id: str) -> RefreshTokenRecord | None:
        raw = self._redis.get(TOKEN_KEY + token_id)
        if not raw:
            return None
        data = json.loads(raw)
        return RefreshTokenRecord(
            token_id=data["tokenId"],
            account_id=int(data["accountId"]),
            identity_id=int(data["identityId"]),
            device_id=data.get("deviceId"),
            issued_at=float(data["issuedAt"]),
        )

    def delete(self, token_id: str) -> None:
        record = self.find(token_id)
        self._redis.delete(TOKEN_KEY + token_id)
        if record:
            self._redis.zrem(INDEX_IDENTITY + str(record.identity_id), token_id)
            self._redis.zrem(INDEX_ACCOUNT + str(record.account_id), token_id)

    def list_for_identity(self, identity_id: int) -> list[RefreshTokenRecord]:
        token_ids = self._redis.zrange(INDEX_IDENTITY + str(identity_id), 0, -1)
        records = [record for tid in token_ids if (record := self.find(tid)) is not None]
        records.sort(key=lambda item: item.issued_at)
        return records

    def list_for_account(self, account_id: int) -> list[RefreshTokenRecord]:
        token_ids = self._redis.zrange(INDEX_ACCOUNT + str(account_id), 0, -1)
        records = [record for tid in token_ids if (record := self.find(tid)) is not None]
        records.sort(key=lambda item: item.issued_at)
        return records

    def revoke_all_for_identity(self, identity_id: int) -> None:
        """吊销某身份的全部会话（解绑组织账号、身份被停用时用）。"""
        for record in self.list_for_identity(identity_id):
            self.delete(record.token_id)

    def revoke_device(self, identity_id: int, device_id: str) -> bool:
        for record in self.list_for_identity(identity_id):
            if record.device_id == device_id:
                self.delete(record.token_id)
                return True
        return False

    def enforce_device_limit(self, identity_id: int, max_devices: int) -> None:
        index_key = INDEX_IDENTITY + str(identity_id)
        while int(self._redis.zcard(index_key) or 0) > max_devices:
            oldest = self._redis.zrange(index_key, 0, 0)
            if not oldest:
                break
            token_id = oldest[0]
            record = self.find(token_id)
            self._redis.delete(TOKEN_KEY + token_id)
            if record:
                self._redis.zrem(INDEX_ACCOUNT + str(record.account_id), token_id)
            self._redis.zrem(index_key, token_id)

    def save_successor(self, previous_token_id: str, new_token_id: str, grace: int) -> None:
        if grace <= 0:
            return
        self._redis.set(SUCCESSOR_KEY + previous_token_id, new_token_id, ex=grace)

    def find_successor(self, previous_token_id: str) -> str | None:
        return self._redis.get(SUCCESSOR_KEY + previous_token_id)


def now_seconds() -> float:
    return time.time()
