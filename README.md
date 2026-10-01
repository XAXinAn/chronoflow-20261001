# 时纪流（ChronoFlow）

智能日程与待办管理应用。个人账号手动管理日历日程与待办；组织账号在此基础上增加由组织管理员统一下发的组织日历；Web 后台同时服务平台超管与组织管理员。

产品与技术规格见 [spec.md](./spec.md)，视觉风格为**黑白极简 · 高级质感 · 动态呼吸感**（spec §7.6）。

## 仓库结构

```
xa-todo/
├── spec.md             产品与技术规格说明书（唯一事实来源）
├── contract/           跨语言 API 契约（Java 与 Python 两版共同校验）
├── backend-java/       阶段一后端：Java 21 + Spring Boot 3
├── backend-python/     阶段二后端：FastAPI 平行重写（与 Java 版同一份契约）
├── app/                App 端：React Native + Expo
├── web-admin/          Web 后台：React + Vite + Ant Design（超管端 + 组织管理端）
├── packages/           共享包（design-tokens：设计令牌唯一来源）
├── scripts/            节假日数据、模拟企业数据集等运维脚本
└── deploy/             Docker Compose 与 Nginx 配置
```

## 当前进度

| 部分 | 状态 |
| --- | --- |
| 需求与规格（spec.md） | 完成 |
| 数据库结构（V1–V19 迁移，由 Flyway 独占管理） | 完成 |
| 后端 Java（common / auth / personal / org / support / agent / admin） | 完成（**150 项**集成测试 + 契约门禁） |
| 设计令牌 packages/design-tokens | 完成（1 个测试文件，覆盖 35 个 CSS 变量） |
| Web 后台 web-admin | 完成：超管端 + 组织管理端 + 意见反馈（21 项测试） |
| App 端 app | 核心流程可用（**215 项**纯逻辑层测试，组件无渲染测试） |
| 智能助手「小安」 | 完成：流式对话 + 个人日程工具 + 逐条授权 + 语音输入（**Java 与 Python 两版都有**，见 spec §11 阶段三） |
| 图片识别日程 | 完成：端侧 OCR（图片不出手机）→ 服务端解析 → 确认页 → 草稿编辑器 → 一键添加（spec §4.1.9） |
| 阶段二 backend-python | 完成（契约覆盖率 100%，**76 项**测试） |
| CI 与 API 契约测试 | 完成（GitHub Actions） |
| 上架合规（隐私政策 / 注销 / 权限告知） | 完成（spec §12，`scripts/check_compliance.py` 20 项门禁已进 CI） |
| 生产部署编排（Dockerfile / docker-compose / Nginx） | 完成，已部署到 `http://8.136.20.182:8088` |

## API 契约

[`contract/api-contract.json`](./contract/api-contract.json) 是**跨语言共享**的接口清单（**111 个端点**）。
Java 版与阶段二的 Python 版都必须满足它——改动这个文件等于改动契约，
必须同时更新两版实现与 `spec.md`。

契约测试（`OpenApiContractTest`）做两件事：

1. 生成的 OpenAPI 文档必须覆盖契约里的每个方法 + 路径，且安全声明与实际鉴权一致；
2. **实际发一次未携带令牌的请求**，验证受保护接口确实返回 401、公开接口确实不返回 401。

第 2 点是行为验证而非文档验证——注解写错了同样会导致失败。
构建产物中的 `target/openapi/xatodo-api.json` 可在 CI 里作为 artifact 下载。

详见 [backend-java/README.md](./backend-java/README.md) 与 [web-admin/README.md](./web-admin/README.md)。

## 上架合规

应用商店（应用宝）上架要求见 [spec.md §12](./spec.md)：

- **合规文本**（隐私政策 / 用户协议 / 儿童隐私声明 / 两份清单）的唯一事实来源是
  [`docs/legal/`](./docs/legal/)，后端渲染成纯静态 HTML 挂在 `GET /api/v1/legal/{doc}`，
  **App 内也是 WebView 打开同一个地址**——因此「App 内与商店链接内容完全一致」是结构上成立的。
- 逐条对照清单：[docs/legal/compliance-checklist.md](./docs/legal/compliance-checklist.md)。
- 每个版本都要跑的自动门禁（CI 里已接入）：

  ```bash
  python3 scripts/check_compliance.py            # 日常：19 项自动检查
  python3 scripts/check_compliance.py --strict    # 提交审核前：另把【待替换：…】占位判为错误
  ```

  运营主体是**舟山市时纪云人工智能应用软件开发有限公司**（统一社会信用代码 91330901MAK8W0UM38），
  应用宝后台「基础信息 → 运营者 / 开发者」必须填同一个名称。

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

# 6) App 端：类型检查与逻辑测试
npm run typecheck
npm run test -w @xa-todo/app

# 7) 启动 App（模拟器调试步骤见 app/README.md）
npm run dev:app
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

## CI

`.github/workflows/ci.yml` 两个 job：

| Job | 内容 |
| --- | --- |
| 后端 | `mvn clean verify`；测试自带嵌入式 PostgreSQL 与 Redis，**无需 service 容器**；契约测试作为门禁 |
| 前端 | `npm ci` → 构建设计令牌 → 构建 Web 后台 → App 类型检查 → 全部单测 |

本地等价命令：

```bash
cd backend-java && mvn clean verify && cd ..
npm ci && npm run build && npm test
```
