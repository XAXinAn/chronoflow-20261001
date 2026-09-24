# backend-java —— XaTodo 后端（阶段一）

Java 21 + Spring Boot 3 实现，对应 [spec.md](../spec.md) 阶段一。阶段二的 `backend-python` 会平行重写同一份 API。

## 当前进度

| 模块 | 内容 | 状态 |
| --- | --- | --- |
| `xa-common` | 统一响应体 `ApiResponse`、错误码 `ErrorCode`、分页 `PageResult`、`BizException`、`TraceIdFilter` | 已完成 |
| `xa-bootstrap` | 启动入口、安全配置、全局异常、OpenAPI、系统探活接口、Flyway 全量建表脚本 | 已完成 |
| 领域模块 | `auth` / `personal` / `org` / `admin`（spec §8.5） | 待开发 |

数据库结构已按 spec §5 全量落地（19 张表，V1–V6 六个迁移脚本），但**业务接口尚未实现**。

## 环境要求

- JDK 21
- Maven 3.9+
- PostgreSQL 16+（本地开发可用 Docker Compose 启动，见 `deploy/`）

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

测试使用 **zonky 嵌入式 PostgreSQL**（免 Docker），会真实执行全部 Flyway 迁移并校验表结构与关键约束。

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
| GET | `/actuator/health` | 健康检查 |
| GET | `/swagger-ui.html` | OpenAPI 文档 |

除上述路径外，所有接口默认要求认证（未认证返回 HTTP 401 + 统一响应体）。

## 约定

- 统一响应体：`{code, message, data, traceId}`，错误码分段见 spec §6.1。
- 业务可预期错误返回 HTTP 200，语义由 `code` 表达；参数错误 400、未认证 401、无权限 403、系统异常 500。
- 时间字段统一 `timestamptz`，写库转 UTC。
