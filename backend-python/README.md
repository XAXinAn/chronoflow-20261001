# backend-python —— 时纪流后端（阶段二）

FastAPI 平行重写，对外契约与 Java 版完全一致（同一份 `contract/api-contract.json`）。目标是可以与 Java 版互换部署。

## 与 Java 版共享的东西

这是本阶段最关键的设计——不是「再写一个后端」，而是「同一个后端的另一种实现」：

| 共享项 | 说明 |
| --- | --- |
| 数据库 schema | 由 **Flyway 独占管理**（迁移文件在 `backend-java` 下），Python 版只读写不建表 |
| Redis 键规范 | `sms:code:{phone}`、`rt:{tokenId}`、`rt:idx:i:{identityId}` … 逐字一致 |
| JWT | 同一密钥、同一 claim 结构（`scope`/`identityId`/`identityType`/`orgId`），**两版签发的令牌可互换** |
| 响应体与错误码 | `{code, message, data, traceId}` 与 `1xxxx`–`9xxxx` 分段完全一致 |
| 密码哈希 | 都用 BCrypt，两版产出的哈希互相可校验 |
| 契约测试 | 读取同一份 `contract/api-contract.json` |

由于会话状态存在同一套 Redis 键下，两版甚至可以在同一套基础设施上灰度切换。

## 开发

```bash
python3 -m venv --without-pip .venv          # 本机 Python 无 pip / ensurepip
curl -sS -o /tmp/get-pip.py https://bootstrap.pypa.io/get-pip.py
.venv/bin/python /tmp/get-pip.py
.venv/bin/pip install -e ".[dev]"

# 本地没有 root，装不了 postgresql / redis-server；
# 从 Maven 仓库里已有的嵌入式 jar 提取（与 Java 测试同一份二进制）
./scripts/setup-test-deps.sh

python -m pytest
uvicorn app.main:app --reload --port 8080
```

CI 上有 root，直接 `apt-get install postgresql redis-server` 并设置
`XA_TODO_PG_BIN` 即可，见 `.github/workflows/ci.yml`。

## 当前实现范围

| 模块 | 状态 |
| --- | --- |
| 统一响应体 / 错误码 / traceId | 完成 |
| 认证（短信、密码、身份选择与切换、令牌轮换与宽限期、登出） | 完成 |
| 账号设置（资料、密码、设备、通知偏好） | 完成 |
| 个人日历 / 日程（RRULE + 例外 + THIS/FUTURE/ALL）/ 待办 / 提醒 / 互转 | 完成 |
| 组织、部门树、成员、批量导入、组织日历下发（首版不收集回执） | 完成 |
| 智能助手「小安」（`/ai/agent/chat` SSE + `/ai/agent/approvals` + `/ai/transcribe`） | 完成（与 Java 版同一套工具语义、同一份提示词、同一套事件形状） |
| 平台超管后台（组织、账号、管理员、配置、看板、审计） | 完成 |

**契约覆盖率 100%（112/112 端点）**，由 `tests/test_contract.py` 里的棘轮常量守着，不允许倒退。
测试 76 项，覆盖认证链路、时区展开、THIS/FUTURE 范围、部门递归权限、下发快照、
助手的工具循环 / 授权回路 / 隔离沙盒，以及「OCR 文字 → 日程草稿」的解析。

助手的模型配置与 Java 版**同名环境变量**（`XATODO_AGENT_BASE_URL` / `XATODO_AGENT_API_KEY` /
`XATODO_AGENT_MODEL` / `XATODO_ASR_*`），两边可以指向同一个模型、共用同一份 `.env`。
`XATODO_AGENT_API_KEY` 留空 = 未接入：`/ai/agent/chat` 直接返回 `90002`，
`/system/info` 的 `aiAgentEnabled=false`，App 保持「还没有接入模型」的提示。

> 提示词正文在 `app/resources/agent/prompt.md`，与 Java 版 `xa-agent` 里那一份
> **必须逐字节相同**（`tests/test_agent.py` 钉住了）。改提示词要同时改两份与两边的 VERSION。

## 踩过的三个坑

**SQLAlchemy 会覆盖数据库默认值**：只要映射了某列却没给 `server_default`，
ORM 就会在 INSERT 时显式写 NULL，把 `DEFAULT now()` 顶掉。凡是「值由数据库生成」
的列都必须声明 `server_default`。

**jsonb 列不能用 String 映射**：psycopg 会按 varchar 发送参数，PostgreSQL 拒绝隐式转换。
用 `JSONB` 类型直接传 dict（Java 侧对应的是自定义 `JsonbStringTypeHandler`）。

**写操作必须显式 commit**：Java 侧靠 `@Transactional`，Python 侧没有等价物——
`get_session` 只负责关闭会话，忘记 commit 的写操作会随请求结束被静默回滚。
表现是「接口返回成功但数据不存在」，排查起来很费时间。

另外要注意 `model_dump()` 会带上值为 `None` 的可选字段，
`payload.get("includeSubDepartments", True)` 取到的是 `None` 而不是默认值，
需要先判 `None` 再给默认值。
