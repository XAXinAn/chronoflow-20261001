# backend-java —— XaTodo 后端（阶段一）

Java 21 + Spring Boot 3 实现，对应 [spec.md](../spec.md) 阶段一。阶段二的 `backend-python` 会平行重写同一份 API。

## 当前进度

| 模块 | 内容 | 状态 |
| --- | --- | --- |
| `xa-common` | 统一响应体 `ApiResponse`、错误码 `ErrorCode`、分页 `PageResult`、`BizException`、`TraceIdFilter` | 已完成 |
| `xa-auth` | 短信验证码登录、身份列表 / 选择 / 切换、JWT 与刷新令牌、个人身份创建 | 已完成 |
| `xa-bootstrap` | 启动入口、安全配置、全局异常、OpenAPI、系统探活接口、Flyway 全量建表脚本 | 已完成 |
| `personal` / `org` / `admin` 模块 | 日历日程待办、组织与下发、Web 后台（spec §8.5） | 待开发 |

数据库结构已按 spec §5 全量落地（19 张表，V1–V6 六个迁移脚本）；认证链路端到端可用。

未实现部分：密码登录、微信登录、绑定第三方、账号设置（`PATCH /me`）、真实短信通道、推送。

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
