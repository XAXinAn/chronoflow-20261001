# 时纪流（ChronoFlow）部署与发布手册

> 这份文档回答三件事：**代码更新后怎么部署**、**App 怎么发版并让用户自动更新**、**出问题先看哪里**。
> 环境相关的事实（地址、账号、密钥路径、容器名）都在第 1 节，交接时以这一节为准。

---

## 1. 环境总览

| 用途 | 地址 | 备注 |
| --- | --- | --- |
| **演示环境（现用）** | `http://60.205.142.205:8080` | 阿里云 ECS，同时跑：App 后端 + Web 管理端（nginx）+ PostgreSQL + Redis |
| **老环境（历史）** | `http://8.136.20.182:8088` | 老项目（时纪流旧版 + 老 chronoflow 服务），**不要往它上面部署新版本** |
| **Web 管理端** | `http://60.205.142.205:8080/` | 超管 `admin` / `CTOq90h1favAc4eC`（演示凭据，上线前必须改） |
| **App 安装包** | `http://60.205.142.205:8080/downloads/chronoflow-<版本>.apk` | 也是应用内更新的下载地址 |

**SSH 私钥**（`域名-地域.pem` 命名）：

| 服务器 | 域名 | 密钥路径（WSL） | 桌面副本 |
| --- | --- | --- | --- |
| 北京 `60.205.142.205` | `xaxinan.top`（邮件发信域，暂无 A 记录） | `~/.ssh/xaxinan.top-北京.pem` | `xaxinan.top-北京.pem` |
| 杭州 `8.136.20.182` | `chronocloud.top`（DNS 指向它，有证书） | `~/develop/workspace/chronocloud.top-杭州.pem` | `chronocloud.top-杭州.pem` |

⚠️ 桌面那两份是**服务器 root 私钥**，Windows 侧所有人可读；用完请删，长期使用放 `C:\Users\jiang\.ssh\` 并收紧权限。

**容器**（都在 `60.205.142.205` 的 `/opt/chronoflow`，用 **`docker compose`（v2 插件）**，没有 `docker-compose`）：

| 容器 | 作用 | 端口 |
| --- | --- | --- |
| `chronoflow-web` | nginx：管理端静态页 + 反代 `/api` `/uploads` `/map` `/downloads` | 宿主 8080 → 容器 80 |
| `chronoflow-backend` | Spring Boot（`app.jar`） | `127.0.0.1:18080` → 8080 |
| `chronoflow-db` / `chronoflow-redis` | PostgreSQL / Redis | 仅内网 |

---

## 2. 部署后端（Java，最常用）

代码入口：`backend-java/`（**Java 21**，离线 Maven 在 `/home/jiang/tools/apache-maven-3.9.16`）。

```bash
# ① 本地打包（跳过测试；跑测试用 mvn -o test）
cd ~/develop/xa-todo/backend-java
export JAVA_HOME=/home/jiang/tools/jdk-21.0.12.1+1
/home/jiang/tools/apache-maven-3.9.16/bin/mvn -o -q package -DskipTests

# ② 传 jar（文件名固定，Dockerfile 里写死了）
scp -i ~/.ssh/xaxinan.top-北京.pem \
  chronoflow-bootstrap/target/chronoflow-bootstrap-0.1.0-SNAPSHOT.jar \
  root@60.205.142.205:/opt/chronoflow/backend/

# ③ 重建并重启后端容器
ssh -i ~/.ssh/xaxinan.top-北京.pem root@60.205.142.205 \
  'cd /opt/chronoflow && docker compose up -d --build backend'
```

**验证**（必须做，别只看"容器起来了"）：

```bash
# 免登录接口 200，受保护接口 401（401 = 路由在、只是没带令牌；404 说明没部署上）
curl -s -o /dev/null -w '%{http_code}\n' http://60.205.142.205:8080/api/v1/system/info
curl -s -o /dev/null -w '%{http_code}\n' http://60.205.142.205:8080/api/v1/me/security
```

⏱️ **重启窗口约 30–45 秒**（Spring Boot 启动）：这段时间访问会 **502**，属正常现象，等一会儿再验。

**为什么要走这个流程而不是在服务器上编译**：那台 2C/3.4G 还要跑 PG 与 Redis，本地打包更稳；而且 `mvn package` 在本机有缓存，通常十几秒。

---

## 3. 部署 Web 管理端

```bash
cd ~/develop/xa-todo
npm run build -w @chronoflow/web-admin          # 产物在 web-admin/dist
scp -r -i ~/.ssh/xaxinan.top-北京.pem web-admin/dist root@60.205.142.205:/opt/chronoflow/web/
ssh -i ~/.ssh/xaxinan.top-北京.pem root@60.205.142.205 \
  'cd /opt/chronoflow && docker compose up -d --build web'
```

**用户侧怎么生效**：静态资源文件名带 hash，用户**刷新页面**即可，不需要重装任何东西。
如果看到"登录点了没反应 / 界面还是旧的"，先 **Ctrl+F5 硬刷新**。

**一条必须知道的历史坑**：管理端的 API 地址在生产必须**同源**（`/api/...`），不能写死 `http://localhost:8080`
（浏览器会去请求用户自己的机器）；而改成同源后又踩过 `new URL('/api/...')` 缺 base 抛 `Invalid URL`
——现在两者都修好了，`web-admin/src/api/client.ts` 里有注释与单测盯着，别改回去。

---

## 4. App 出包 → 发布 → 自动更新（完整链路）

### 4.1 出包

```bash
cd ~/develop/xa-todo

# ① 先改版本号：app/app.json 的 version 与 android.versionCode（**必须递增**）
#    versionName 给人看，versionCode 决定客户端认不认这是新版本

# ② 出 release 包（脚本会自己：补模型、把版本号钉进 build.gradle、压内存、检查 16KB 对齐）
bash scripts/build_apk.sh --release --archs=arm64-v8a,x86_64
# 产物：app/android/app/build/outputs/apk/release/app-release.apk
#       并自动复制一份到桌面 chronoflow-<版本>.apk
```

`build_apk.sh` 每次构建前会自动做四件事，**不要绕开脚本直接 gradle**：

1. 确认端侧 OCR 模型在位（缺了会跑 `scripts/fetch_ppocr_models.sh` 下载）；
2. 把 `app.json` 的 `versionName/versionCode` **钉进 `android/app/build.gradle`**
   （`android/` 是 prebuild 生成的，只改 app.json 不生效——曾经因此出过"包名写 0.0.2、包内还是 0.0.1"的事故）；
3. 给第三方模块打补丁（onnxruntime 的 Gradle 9 兼容 + 16KB 页对齐）；
4. 构建后**硬卡**包内所有 `.so` 的 16KB 对齐（Android 15+ 的 16KB 页机型要求，不通过直接失败）。

### 4.2 发布（这一步才让用户"看到更新"）

```bash
# 传包 + 打印要写进 .env 的九行
bash scripts/publish_apk.sh \
  app/android/app/build/outputs/apk/release/app-release.apk \
  <版本名> <versionCode> "<更新说明，多条用 | 分隔>"
```

然后把脚本打印的九行 `CHRONOFLOW_APP_RELEASE_*` 写进服务器 `/opt/chronoflow/.env`（**改前备份**），重启后端：

```bash
ssh -i ~/.ssh/xaxinan.top-北京.pem root@60.205.142.205 '
  cd /opt/chronoflow && cp -a .env .env.bak.$(date -u +%Y%m%dT%H%M%SZ) && \
  docker compose up -d backend'
```

**验证发布是否生效**：

```bash
curl -s http://60.205.142.205:8080/api/v1/system/app-release     # versionCode 应为新值
curl -sI http://60.205.142.205:8080/downloads/chronoflow-<版本>.apk | head -3   # 200 + Content-Length
```

> 也可以直接在服务器上跑一段 python 把九行写进 `.env`（我们历次发布都是这么做的），
> 要点只有一个：**动 `.env` 前先 `cp -a` 备份**，改完 `docker compose up -d backend`。

### 4.3 客户端是怎么"自动更新"的

| 环节 | 行为 |
| --- | --- |
| 检查时机 | ① App 启动静默检查一次；② 「我的 → 支持 → 检查更新」手动检查 |
| 判定依据 | `GET /api/v1/system/app-release` 返回的 `versionCode` **大于**本机 versionCode 才提示 |
| 提示内容 | 版本名 + 更新说明（`.env` 里 `\|` 分隔的多条会拆成列表）+ 包大小 |
| 下载 | App 内下载，带进度；用 `.env` 里的 `sizeBytes` / `sha256` 校验 |
| 安装 | 交给**系统安装器**（不静默安装）；用户点确认才装 |
| 强更 | `.env` 的 `CHRONOFLOW_APP_RELEASE_FORCE=true` 时不给「稍后」 |
| 没配置 | `versionCode = 0` → 客户端认为"不提供更新"，**绝不编版本号** |
| 读不到本机版本（Expo Go / Web） | 不检查更新 |

⚠️ **三个铁律**：
1. `versionCode` 必须**严格递增**（相同或更小，客户端不会提示；装上去还会出现"提示有新版本却装不上"）；
2. `.env` 的 `APK_URL` 指向的包必须真的存在（`publish_apk.sh` 已按 `chronoflow-<版本>.apk` 命名上传）；
3. 发布后**用 curl 验一遍** app-release 与下载链接，再告诉用户"可以更新了"。

**回滚**：App 侧的"降级"很麻烦（系统不允许装低 versionCode）。正确做法是**发一个修好的更高版本**；
如果只是配置错了，把 `.env` 的九行指回旧包并重启后端即可（用户侧表现为"最新版回到旧版"）。

---

## 5. 数据库迁移（Flyway）

- 迁移文件在 `backend-java/chronoflow-bootstrap/src/main/resources/db/migration/`，**只增不改**：
  历史文件（V1…V20…）一个字节都不能动，Flyway 按校验和判断，改了**老库直接起不来**。
- 新改动 = 新开 `V21__xxx.sql`。
- 后端启动时自动执行迁移；部署新 jar 就等于跑迁移，**不需要手工连库**。

---

## 6. 出问题先看哪里（排障顺序）

1. **请求到底有没有到服务器**（最容易分辨"前端问题"还是"后端问题"）：
   ```bash
   ssh -i ~/.ssh/xaxinan.top-北京.pem root@60.205.142.205 'docker logs --tail 50 chronoflow-web'
   ```
   nginx 日志里**没有那条请求** → 前端/客户端的问题（缓存、地址、代码抛错）。
2. **后端日志**（业务异常会带错误码与原因）：
   ```bash
   ssh -i ~/.ssh/xaxinan.top-北京.pem root@60.205.142.205 'docker logs --tail 100 chronoflow-backend'
   ```
3. **App 端**（真机 / 模拟器）：
   ```bash
   adb logcat -d | grep -E "ReactNativeJS|FATAL|AndroidRuntime" | tail -30
   adb logcat -d -b crash > %USERPROFILE%\Desktop\crash.txt   # Windows 下抓崩溃
   ```

| 现象 | 先怀疑 |
| --- | --- |
| 刚部署完报 **502** | 后端还在启动（30–45 秒），等一下再试 |
| 管理端"登录点了没反应" | 浏览器缓存（Ctrl+F5）→ 前端 API 地址是否同源 |
| App 一打开/某功能**闪退** | 原生模块与权限：`PackageList` 里有没有那个模块、`.so` 是否 16KB 对齐、权限是否被插件删掉 |
| 收不到邮件验证码 | 先看垃圾箱；后端日志里 `邮件被拒` 会带阿里云错误码 |
| 发现新版本却装不上 | `versionCode` 没有真正递增（`aapt2 dump badging <apk>` 可核对包里实际值） |

---

## 7. 交接清单（2026-10-02 收尾时）

**当前状态**：线上 App **0.0.9**（versionCode 10），后端与 Web 管理端均已部署新 jar/dist；`origin/main` 与本地同步。

**已完成并验证**
- 端侧 OCR = PaddleOCR PP-OCRv4（模型进包、构建期 16KB 硬卡）
- 两次闪退真因：`libonnxruntimejsi.so` 未 16KB 对齐 + onnxruntime 原生模块没被自动链接（已手工接入 + 兜底判空）
- 麦克风权限被 expo-image-picker 的 `microphonePermission:false` 删掉（已修）
- 「我的」页：5 个分类入口、头部展示手机号/实名/邮箱、切换手机号（旧号+新号双验证码）
- 实名认证（CloudAuth H5+iframe）与邮箱绑定（DirectMail）：代码与端点已上线
- 管理端登录修复（同源 + `new URL` 缺 base）

**待验证 / 待办**
1. 真机验「上传图片识别日程」的**准确率与耗时**（链路已通，识别效果未验）；
2. 实名认证**真机走一遍**：H5/iframe 要求页面 HTTPS，目前靠 WebView 的 baseUrl 造 https 源，
   若摄像头被拦，需要给演示环境配 HTTPS 域名（`chronocloud.top` 已有证书，可考虑迁过来）；
3. APK 166MB 瘦身（只留 arm64 / 换 `onnxruntime-mobile`）；
4. iOS 只能到"代码就绪"（需要 macOS 出包）；
5. Python 后端测试套件在本机起不来（缺嵌入式 PG/Redis），上线前建议补跑一遍。

---

## 8. 一分钟速查

```bash
# 后端
cd ~/develop/xa-todo/backend-java && export JAVA_HOME=/home/jiang/tools/jdk-21.0.12.1+1 && \
  /home/jiang/tools/apache-maven-3.9.16/bin/mvn -o -q package -DskipTests
scp -i ~/.ssh/xaxinan.top-北京.pem chronoflow-bootstrap/target/chronoflow-bootstrap-0.1.0-SNAPSHOT.jar root@60.205.142.205:/opt/chronoflow/backend/
ssh -i ~/.ssh/xaxinan.top-北京.pem root@60.205.142.205 'cd /opt/chronoflow && docker compose up -d --build backend'

# 管理端
cd ~/develop/xa-todo && npm run build -w @chronoflow/web-admin
scp -r -i ~/.ssh/xaxinan.top-北京.pem web-admin/dist root@60.205.142.205:/opt/chronoflow/web/
ssh -i ~/.ssh/xaxinan.top-北京.pem root@60.205.142.205 'cd /opt/chronoflow && docker compose up -d --build web'

# App 出包 + 发布
cd ~/develop/xa-todo && bash scripts/build_apk.sh --release --archs=arm64-v8a,x86_64
bash scripts/publish_apk.sh app/android/app/build/outputs/apk/release/app-release.apk <版本名> <versionCode> "<更新说明>"
# → 把打印的九行写进 /opt/chronoflow/.env → docker compose up -d backend → curl 验 app-release
```
