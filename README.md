# XaTodo（心安待办）

智能日程与待办管理应用。个人账号手动管理日历日程与待办；组织账号在此基础上增加由组织管理员统一下发的组织日历；Web 后台同时服务平台超管与组织管理员。

产品与技术规格见 [spec.md](./spec.md)，视觉风格为**黑白极简 · 高级质感 · 动态呼吸感**（spec §7.6）。

## 仓库结构

```
xa-todo/
├── spec.md             产品与技术规格说明书（唯一事实来源）
├── docs/               补充设计文档、接口样例
├── backend-java/       阶段一后端：Java 21 + Spring Boot 3
├── backend-python/     阶段二后端：FastAPI 平行重写（尚未开始）
├── app/                App 端：React Native + Expo（尚未开始）
├── web-admin/          Web 后台：React + Vite + Ant Design
├── packages/           共享包（design-tokens：设计令牌唯一来源）
└── deploy/             Docker Compose 与 Nginx 配置
```

## 当前进度

| 部分 | 状态 |
| --- | --- |
| 需求与规格（spec.md） | 完成 |
| 数据库结构（19 张表 / V1–V7 迁移） | 完成 |
| 后端（common / auth / personal / org / admin） | 完成（43 项集成测试） |
| 设计令牌 packages/design-tokens | 完成（7 项测试） |
| Web 后台 web-admin | 完成（15 项测试） |
| App 端 | 未开始 |
| 阶段二 backend-python | 未开始 |
| CI、OpenAPI 契约测试、生产部署编排 | 未开始 |

详见 [backend-java/README.md](./backend-java/README.md) 与 [web-admin/README.md](./web-admin/README.md)。

## 快速开始

```bash
# 1) 启动基础设施（PostgreSQL / Redis / MinIO）
docker compose -f deploy/docker-compose.infra.yml up -d

# 2) 构建并测试后端
cd backend-java && mvn clean verify

# 3) 运行后端
mvn -pl xa-bootstrap spring-boot:run

# 4) 构建并测试前端（设计令牌需先构建）
cd .. && npm install
npm run build -w @xa-todo/design-tokens
npm run test  -w @xa-todo/web-admin

# 5) 启动 Web 后台（默认 http://127.0.0.1:5173）
npm run dev:web
```

后端默认监听 `8080`，探活接口 `GET /api/v1/system/ping`。
后台初始账号由 `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD` 决定。

## 开发环境注意事项

- 本机为 Windows + WSL2。免 root 的便携工具链位于 `/home/jiang/tools`，使用前需设置：

  ```bash
  export JAVA_HOME=/home/jiang/tools/jdk-21.0.12.1+1
  export PATH="$JAVA_HOME/bin:/home/jiang/tools/apache-maven-3.9.16/bin:$PATH"
  ```

- Maven 依赖走阿里云镜像（配置在 `~/.m2/settings.xml`），直连 Maven Central 约 20KB/s 不可用。
- npm 依赖走 npmmirror（配置在 `~/.npmrc`），直连约 1MB/s、镜像约 7MB/s。
- Android 模拟器调试需在 Windows 侧启动 AVD，详见 spec §8.3；iOS 模拟器在当前环境不可用。
