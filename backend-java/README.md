# backend-java —— 时纪流后端（阶段一）

Java 21 + Spring Boot 3 实现，对应 [spec.md](../spec.md) 阶段一。阶段二的 `backend-python` 会平行重写同一份 API。

## 当前进度

| 模块 | 内容 | 状态 |
| --- | --- | --- |
| `xa-common` | 统一响应体 `ApiResponse`、错误码 `ErrorCode`、分页 `PageResult`、`BizException`、`TraceIdFilter` | 已完成 |
| `xa-auth` | 短信验证码登录、身份列表 / 选择 / 切换、JWT 与刷新令牌、个人身份创建 | 已完成 |
| `xa-personal` | 个人日历、日程（RRULE 重复 + 例外 + THIS/FUTURE/ALL 范围）、待办与子任务、节假日同步 | 已完成 |
| `xa-org` | 组织、部门树、成员管理、组织日历下发（**不收集回执**） | 已完成 |
| `xa-admin` | 平台超管后台：组织、账号、管理员、全局配置、看板、审计 | 已完成 |
| `xa-support` | 意见反馈、推送设备登记与极光推送（JPush） | 已完成 |
| `xa-agent` | 智能助手「小安」：对话 / 工具循环 / 逐条授权 / 语音转写，以及「OCR 文字 → 日程草稿」的解析 | 已完成 |
| `xa-bootstrap` | 启动入口、安全配置、全局异常、OpenAPI、系统探活接口、Flyway 全量建表脚本 | 已完成 |

数据库结构已按 spec §5 全量落地（**V1–V19** 共 19 个迁移脚本）；
认证、个人日程 / 待办、组织下发、平台超管后台、智能助手端到端可用。

未实现部分：微信登录与绑定、邮箱绑定、对象存储接入（导入原文件暂只记引用占位）、
后台双因素认证（TOTP）。短信与推送（极光）需要外部凭证，配好即用。

> 微信 / 邮箱绑定暂缓：前者需要微信开放平台的应用凭证，后者需要邮件通道，
> 两者都属于外部依赖而非代码缺口。`account` 表已预留 `wechat_unionid` / `email` 字段。

### 提醒与日程互转（spec §4.1）

- `PUT /reminders` 是**整体覆盖**语义：先清空该目标下当前身份的全部提醒再写入，
  客户端不必自己算增删差异；传空数组即清空。提醒只能挂在自己有权访问的日程 / 待办上。
- `POST /events/{id}/convert-to-task` 与 `POST /tasks/{id}/convert-to-event` 都是
  「新建目标 + 把来源标记取消」，不做原地改类型——原地改类型会让挂在来源上的提醒等关联失效。
  待办转日程只写一个时间点 `at`：没给就回退到待办的截止时间（`due_at`），没有截止时间则报错。

### 账号设置（spec §6.2）

| 端点 | 说明 |
| --- | --- |
| `PATCH /me` | 修改昵称 / 头像 / 时区 |
| `PUT /me/password` | 设置或修改密码；已有密码时必须提供原密码 |
| `POST /auth/login/password` | 手机号 + 密码登录（复用与短信登录相同的身份选择流程） |
| `GET /me/devices` | 当前身份的活跃设备（来自 Redis 中的刷新令牌索引） |
| `DELETE /me/devices/{deviceId}` | 踢出指定设备，其刷新令牌立即失效 |
| `PUT /me/notifications` | 通知偏好整体覆盖，存 `identity.notification_prefs`（jsonb） |

### 平台超管后台（spec §4.4）

后台是**独立账号密码体系**（用户名 + BCrypt），与 C 端手机号体系完全隔离：
管理员令牌作用域为 `ADMIN`，无法访问 C 端业务接口，反之亦然。

首次启动且 `admin_user` 表为空时，会自动创建初始超管，可用环境变量覆盖：

```bash
export ADMIN_BOOTSTRAP_USERNAME=admin
export ADMIN_BOOTSTRAP_PASSWORD=<强密码>   # 默认 admin123456，仅限本地开发
```

| 分组 | 端点 |
| --- | --- |
| 登录 | `POST /admin/auth/login`、`GET /admin/me`、`PUT /admin/me/password` |
| 组织 | `GET/POST /admin/organizations`、`GET/PATCH/DELETE /{id}`、`POST /{id}/status` |
| 账号 | `GET /admin/accounts`、`POST /accounts/{id}/status`、`POST /identities/{id}/status`、`POST /accounts/{id}/force-logout` |
| 管理员 | `GET/POST /admin/admins`、`PATCH /admin/admins/{id}`、`POST /{id}/reset-password` |
| 配置 | `GET /admin/configs`、`PUT /admin/configs/{key}` |
| 看板审计 | `GET /admin/dashboard/stats`、`GET /admin/audit-logs`、`GET /admin/audit-logs/export` |

实现要点：

- 创建组织时**同步创建首位组织管理员**，避免出现无人能登录的空组织。
- 组织管理员只能读自己组织的数据；所有超管专属接口在 Service 层校验角色，越权返回 `20003`。
- 封禁账号 / 停用身份会**吊销该账号全部刷新令牌**，线上会话无法续期。
- 停用组织后，该组织成员访问组织接口直接返回 `20003`（组织状态在权限判定入口统一校验）。
- 所有超管写操作写入 `audit_log`，支持按动作、操作人、组织、时间检索与导出 CSV。
- 后台登录连续失败 5 次锁定 15 分钟，并记录登录日志（`login_log`）。

> 看板目前是即席 `count` 查询；数据量上升后应改为预聚合表，README 已记录该演进方向。

### 成员批量导入（spec §4.3）

支持 `.xlsx` 与 `.csv`，模板列：姓名、手机号、邮箱（选填）、工号（选填）、部门路径、角色（选填）。

| 端点 | 说明 |
| --- | --- |
| `POST /org-admin/members/import` | 上传文件（multipart），立即返回 `batchId` |
| `GET /org-admin/members/import/template` | 下载 xlsx 模板 |
| `GET /org-admin/imports` / `{id}` | 批次列表 / 详情与逐行结果 |
| `GET /org-admin/imports/{id}/failures` | 导出失败明细 CSV |

实现要点：

- **异步执行**：上传后立即返回 `batchId`，逐行结果异步产出，前端轮询批次状态。
- **逐行独立事务**：某一行失败只回滚该行。这里是刻意为之——PostgreSQL 中事务一旦出错即进入
  aborted 状态，若整批一个事务，第一行失败会导致后续所有行无法继续（整个批次作废）。
- **部门路径是绝对路径**：`技术中心/后端组` 从组织根开始逐级匹配；不存在的段仅在勾选
  `autoCreateDepartment` 时逐级补建（该开关需组织管理员权限）。
- **手机号被 Excel 当数字存**：读取时按整数还原，避免拿到 `1.38E+10` 这种科学计数法。

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
| PATCH | `/api/v1/me` | 修改昵称 / 头像 / 时区 |
| PUT | `/api/v1/me/password` | 设置或修改密码 |
| GET / DELETE | `/api/v1/me/devices[/{deviceId}]` | 活跃设备列表 / 踢出设备 |
| PUT | `/api/v1/me/notifications` | 通知偏好 |
| POST | `/api/v1/auth/login/password` | 手机号 + 密码登录 |
| PUT / GET | `/api/v1/reminders` | 覆盖 / 查询某日程或待办的提醒 |
| POST | `/api/v1/events/{id}/convert-to-task` | 日程转待办 |
| POST | `/api/v1/tasks/{id}/convert-to-event` | 待办转日程 |
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
| PATCH / DELETE | `/api/v1/org-admin/events/{id}` | 编辑（可带 `redispatch` 补投新成员）/ 删除 |
| GET | `/api/v1/org-admin/events/{id}/receipts` | 回执统计与明细 |
| POST | `/api/v1/org-admin/members/import` | 上传模板批量导入成员 |
| GET | `/api/v1/org-admin/members/import/template` | 下载 xlsx 导入模板 |
| GET | `/api/v1/org-admin/imports[/{id}]` | 导入批次列表 / 详情 |
| GET | `/api/v1/org-admin/imports/{id}/failures` | 导出失败明细 CSV |
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
