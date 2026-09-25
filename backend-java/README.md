# backend-java —— XaTodo 后端（阶段一）

Java 21 + Spring Boot 3 实现，对应 [spec.md](../spec.md) 阶段一。阶段二的 `backend-python` 会平行重写同一份 API。

## 当前进度

| 模块 | 内容 | 状态 |
| --- | --- | --- |
| `xa-common` | 统一响应体 `ApiResponse`、错误码 `ErrorCode`、分页 `PageResult`、`BizException`、`TraceIdFilter` | 已完成 |
| `xa-auth` | 短信验证码登录、身份列表 / 选择 / 切换、JWT 与刷新令牌、个人身份创建 | 已完成 |
| `xa-personal` | 个人日历、日程（RRULE 重复 + 例外 + THIS/FUTURE/ALL 范围）、待办与子任务 | 已完成 |
| `xa-org` | 组织、部门树、成员管理、组织日历下发与回执 | 已完成 |
| `xa-bootstrap` | 启动入口、安全配置、全局异常、OpenAPI、系统探活接口、Flyway 全量建表脚本 | 已完成 |
| `admin` 模块 | 平台超管 Web 后台（组织创建、账号封禁、全局配置、看板、审计） | 待开发 |

数据库结构已按 spec §5 全量落地（19 张表，V1–V6 六个迁移脚本）；
认证、个人日程 / 待办、组织下发与回执端到端可用。

未实现部分：密码登录、微信登录、绑定第三方、账号设置（`PATCH /me`）、真实短信通道、推送、
日程提醒（`/reminders`）、日程↔待办互转、节假日与调休数据、平台超管后台、
**成员批量导入**、组织日程的编辑与删除（当前仅支持创建与撤回）。

### 组织权限模型（spec §2.2）

部门树使用**物化路径**（`path` 形如 `/5/12/`），因此「本部门 + 所有下级」是一次
`path LIKE '/5/%'` 查询。路径结尾的斜杠很关键：它避免了 `/5` 误匹配 `/51` 的经典前缀问题。

| 角色 | 可管理部门 | 可下发范围 |
| --- | --- | --- |
| 拥有者 / 组织管理员 | 全组织 | 全员 / 任意部门 / 任意成员 |
| 部门管理员 | 被授权部门 + 其所有下级 | 本单位范围 / 范围内成员 |
| 普通成员 | 无 | 无（只读 + 回执） |

权限在 Service 层强制校验，不依赖前端隐藏入口：成员调用下发接口返回 `20003`，
部门管理员向兄弟部门下发同样返回 `20003`。

**下发是快照**：下发时按范围展开为成员级 `event_recipient` 记录，
因此后续新入组的成员**不会补收**历史日程（有测试锁定该行为）。

### 组织模块的当前限制

- 组织日程暂不支持 RRULE 重复规则（接口会拒绝；个人日程支持）。
- 回执为**序列级**，不区分重复日程的某一次出现。
- 成员只能改自己那条回执记录，组织日程内容对成员始终只读。
- 已有成员回执后不允许撤回下发（返回 `50002`）。

### 重复日程（spec §4.1.2）

使用 `lib-recur` 展开标准 RRULE。两个容易踩的坑已在实现中处理并有测试锁定：

- **按事件时区展开**：「每周一/三/五 09:00（Asia/Shanghai）」必须落在当地周一上午，
  而不是 UTC 的周一。构造重复迭代器时携带事件时区。
- **`timestamptz` 微秒精度**：`scope=FUTURE` 拆分时要把原序列截止到「本次出现之前」，
  退让量必须大于数据库精度。退让 1 纳秒会被 PostgreSQL 四舍五入回原时刻导致截断失效，
  因此实现中退让 1 毫秒。

编辑范围语义：

| scope | 行为 |
| --- | --- |
| `ALL` | 修改整条序列 |
| `THIS` | 仅本次，写入 `event_exception`（MODIFIED / CANCELLED） |
| `FUTURE` | 本次及以后：原序列截断到本次之前，从本次克隆出新序列并套用新值 |

> 已知限制：若原 RRULE 使用 `COUNT`，`FUTURE` 拆分后新序列会重新计数，建议用 `UNTIL` 表达结束条件。

### 会话保持（spec §3.7）

目标是让正常使用的用户**不感知到需要重新登录**：

| 令牌 | 有效期 | 说明 |
| --- | --- | --- |
| 访问令牌 | 2 小时 | JWT，携带身份上下文 |
| 刷新令牌 | 90 天，滑动续期 | 每次刷新换发新的 90 天令牌，只要用户在窗口内用过 App 就一直保持登录 |
| 注册 / 选择身份令牌 | 30 分钟 | 仅用于首次建号与选定身份 |

关键点：**轮换宽限期 60 秒**。App 并发发起多个刷新请求时，旧刷新令牌在宽限期内被再次提交
会返回同一个新令牌，而不是判定失效把用户踢出登录。这是「莫名其妙要重新登录」最常见的原因。

需要重新登录的情况只有：主动登出、90 天未使用、账号被停用、身份被移除、设备被踢出。

## 环境要求

- JDK 21
- Maven 3.9+
- PostgreSQL 16+（本地开发可用 Docker Compose 启动，见 `deploy/`）
- Redis 7+（验证码与刷新令牌存储）

本机免 root 安装的便携工具链位于 `/home/jiang/tools`：

```bash
export JAVA_HOME=/home/jiang/tools/jdk-21.0.12.1+1
export PATH="$JAVA_HOME/bin:/home/jiang/tools/apache-maven-3.9.16/bin:$PATH"
```

## 构建与测试

```bash
cd backend-java
mvn -q clean verify
```

测试使用 **zonky 嵌入式 PostgreSQL** 与**嵌入式 Redis**（均免 Docker），会真实执行全部 Flyway 迁移，
并跑通完整认证链路（发送验证码 → 登录 → 创建个人身份 → 选择身份 → 刷新 → 登出）。

## 运行

```bash
# 默认连接 localhost:5432/xatodo，可用环境变量覆盖
export DB_URL=jdbc:postgresql://localhost:5432/xatodo
export DB_USERNAME=xatodo
export DB_PASSWORD=xatodo

mvn -pl xa-bootstrap spring-boot:run
```

已开放接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/system/info` | 服务元信息 |
| GET | `/api/v1/system/ping` | 探活 |
| POST | `/api/v1/auth/sms/code` | 发送短信验证码 |
| POST | `/api/v1/auth/login/sms` | 手机号 + 验证码登录 |
| POST | `/api/v1/auth/identity/select` | 凭 selectToken 选定身份 |
| POST | `/api/v1/auth/identity/switch` | 切换身份 |
| POST | `/api/v1/auth/token/refresh` | 刷新令牌（含轮换） |
| POST | `/api/v1/auth/logout` | 登出并吊销刷新令牌 |
| GET | `/api/v1/auth/identities` | 当前账号的身份列表 |
| POST | `/api/v1/identities/personal` | 创建个人身份（Bearer registerToken） |
| GET | `/api/v1/me` | 当前身份信息 |
| GET / POST | `/api/v1/calendars` | 个人日历列表 / 新建（首次访问自动创建默认日历） |
| GET / PATCH / DELETE | `/api/v1/calendars/{id}` | 日历详情 / 编辑 / 停用 |
| GET | `/api/v1/events` | 范围查询（展开重复日程），参数 `start`、`end`、`calendarIds` |
| POST | `/api/v1/events` | 新建日程（支持 `rrule`） |
| GET / PATCH / DELETE | `/api/v1/events/{id}` | 详情 / 编辑 / 删除，支持 `scope=ALL/THIS/FUTURE` 与 `occurrenceDate` |
| GET / POST | `/api/v1/tasks` | 待办列表 / 新建 |
| GET / PATCH / DELETE | `/api/v1/tasks/{id}` | 详情 / 编辑 / 删除 |
| POST | `/api/v1/tasks/{id}/complete` | 完成 / 取消完成 |
| GET | `/api/v1/org/current` | 组织上下文：组织信息 + 我的成员信息与可管理部门 |
| GET | `/api/v1/org/departments/tree` | 组织部门树 |
| GET | `/api/v1/org/members` | 成员列表（按调用者可管理范围自动限定） |
| GET | `/api/v1/org/events` | 成员视角的组织日程（含回执状态），参数 `start`、`end` |
| POST | `/api/v1/org/events/{id}/receipt` | 提交回执 `ACCEPTED`/`DECLINED`/`COMPLETED` |
| POST | `/api/v1/org/events/{id}/read` | 标记已读 |
| GET | `/api/v1/org/events/{id}/recipients` | 回执统计与明细 |
| POST/PATCH/DELETE | `/api/v1/org-admin/departments[/{id}]` | 部门维护 |
| POST | `/api/v1/org-admin/departments/{id}/managers` | 设置部门管理员 |
| GET/POST/PATCH | `/api/v1/org-admin/members[/{id}]` | 成员新增 / 编辑 / 停用 |
| POST | `/api/v1/org-admin/events` | 创建组织日程并下发 |
| POST | `/api/v1/org-admin/events/{id}/revoke` | 撤回下发 |
| GET | `/api/v1/org-admin/events/{id}/receipts` | 回执统计与明细 |
| GET | `/actuator/health` | 健康检查 |
| GET | `/swagger-ui.html` | OpenAPI 文档 |

除上述路径外，所有接口默认要求认证（未认证返回 HTTP 401 + 统一响应体）。

### 认证联调示例

开发环境（`dev` profile）下 `xatodo.auth.expose-sms-code=true`，发送验证码接口会在
`data.debugCode` 中回显验证码，便于本地联调。生产环境该项必须为 `false`。

```bash
# 1) 发送验证码
curl -s -X POST localhost:8080/api/v1/auth/sms/code \
  -H 'Content-Type: application/json' -d '{"phone":"13800000101"}'

# 2) 登录，拿到 registerToken（首次）或 selectToken（已有身份）
curl -s -X POST localhost:8080/api/v1/auth/login/sms \
  -H 'Content-Type: application/json' -d '{"phone":"13800000101","code":"<debugCode>"}'

# 3) 首次登录：创建个人身份并直接拿到令牌
curl -s -X POST localhost:8080/api/v1/identities/personal \
  -H "Authorization: Bearer <registerToken>" -H 'Content-Type: application/json' \
  -d '{"nickname":"小明","deviceId":"dev-1"}'

# 4) 已有身份：选定身份换取令牌
curl -s -X POST localhost:8080/api/v1/auth/identity/select \
  -H 'Content-Type: application/json' \
  -d '{"selectToken":"<selectToken>","identityId":1,"deviceId":"dev-1"}'

# 5) 携带访问令牌访问业务接口
curl -s localhost:8080/api/v1/me -H "Authorization: Bearer <accessToken>"
```

## 约定

- 统一响应体：`{code, message, data, traceId}`，错误码分段见 spec §6.1。
- 业务可预期错误返回 HTTP 200，语义由 `code` 表达；参数错误 400、未认证 401、无权限 403、系统异常 500。
- 时间字段统一 `timestamptz`，写库转 UTC。
