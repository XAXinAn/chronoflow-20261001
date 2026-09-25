# AGENTS.md —— XaTodo 会话交接文档

> 给下一个接手这个仓库的 agent。**开工前先读完这一份**，尤其是「待验证清单」和「环境陷阱」两节。
>
> 最后更新：2026-09-25

---

## 1. 这个项目是什么

XaTodo（心安待办），智能日程与待办 App。项目代号 `xa-todo`。

- **App 端**：个人账号手动管理日历日程与待办；组织账号在此基础上增加组织管理员统一下发的组织日历。
- **Web 后台**：平台超管 + 组织管理员。
- 视觉风格：**黑白极简 · 高级质感 · 动态呼吸感**。

**`spec.md` 是唯一事实来源**。任何需求变更先改 spec，再改代码。改契约要同步改 `contract/api-contract.json` 和两版后端。

---

## 2. 当前进度

| 部分 | 状态 | 测试 |
| --- | --- | --- |
| spec.md | 完成（v1.1） | — |
| backend-java（6 模块） | 完成 | 51 项集成测试全绿 |
| backend-python（FastAPI 平行重写） | 完成，**契约覆盖率 100%（83/83）** | 22 项全绿 |
| packages/design-tokens | 完成 | 7 项 |
| web-admin（React + Vite + AntD） | 完成 | 15 项 |
| app（React Native + Expo） | 功能骨架完成 | 32 项（**仅纯逻辑层**） |

最近几次提交：

```
0411f70 feat(app): 新建日程入口、组织 tab 按身份显示、重做待办与我的两个页面
afcb504 feat(app): 首页改为日历+当日日程，去掉各页顶部标题栏并补导航图标
03ca57d fix(app): 修复请求缺少 Content-Type 与会话未持久化两个阻断性缺陷
6fb41d2 feat(backend-python): 补齐个人、组织与超管三个模块，契约覆盖率 100%
568d77a chore: 跨语言 API 契约测试与 GitHub Actions CI
4c16232 feat: 补齐提醒、日程互转、密码登录与账号设置
```

---

## 3. ⚠️ 待验证清单（**最重要，先做这个**）

上一轮被明确批评「做一件事忘了上一件」。以下是**代码写完但从未真正走通**的功能。**不要开始新功能，先把这些验证完。**

**5 项已全部在模拟器上实机走通**（2026-09-25）。证据都留在后端日志与数据库里，不是"看起来应该行"。

| # | 事项 | 验证结论 | 状态 |
| --- | --- | --- | --- |
| 1 | **新建日程全流程** | 点 `+` → 表单弹出 → 填标题 → 保存 → 列表立即出现「Team 09:00–10:00」；数据库 `event id=1` 落库（Asia/Shanghai，CONFIRMED） | ✅ 通过 |
| 2 | **会话持久化** | `am force-stop` 杀掉 Expo Go 后冷启动，直接进入日历页并加载出个人日程，**未要求重新登录** | ✅ 通过 |
| 3 | **待办页** | 输入框回车新增 →「待办 1 条」；勾选后条目移入「已完成」分组、标题加删除线 | ✅ 通过 |
| 4 | **我的页** | 深色模式整屏切换正常；身份切换成功（个人 ↔ 组织），切换后底部导航自动增减「组织」tab | ✅ 通过 |
| 5 | **组织身份全链路** | 超管建组织 → 组织身份下发日程（部门范围展开 **35** 条成员级记录）→ App 切组织身份看到「季度技术评审会」→ 点「参加」→ `event_recipient.receipt_status=ACCEPTED` 落库 | ✅ 通过 |

### 本轮新发现（都要单独处理，别丢）

1. **组织首位成员无法通过 API 创建（产品断点）**
   `/org-admin/members` 要求调用方已经携带**组织身份令牌**，而首个组织成员没有任何入口可创建；
   超管建组织时"同步创建首位 ORG_ADMIN 后台管理员"，但后台管理员令牌对 `/org-admin/**` 无效
   （该组接口按契约是 `auth: access`，走身份令牌）。于是形成鸡生蛋：**新组织永远加不进第一个成员**。
   验证第 5 项时只能直接写库绕过（见 `scripts/seed_demo_org.py` 的说明）。
   需要补一个超管侧入口，例如 `POST /admin/organizations/{id}/members`。
2. **深色模式偏好没有持久化**：`AppContext.toggleScheme` 只改 React state，App 重启即丢（实测确认）。
3. **App 端地图能力受 Expo Go 限制**：不能引入 `react-native-maps` 这类原生模块，否则必须切自定义 Dev Client。
4. **web-admin 未实现组织管理端**：`web-admin/src` 里搜不到任何 `/org-admin`、`/org/current` 调用，
   与 spec §4.3「Web 后台 —— 组织管理端」的描述不符（现状是只有后端接口）。

### 模拟企业数据集

`scripts/seed_demo_org.py` 可重复执行（按组织编码 / 部门路径 / 手机号判重），一键造出一家模拟大型企业：

```
backend-python/.venv/bin/python scripts/seed_demo_org.py
# 组织 #1 心安科技(XATECH)：43 个部门（中心→部→组 三层）、196 名成员、43 位部门负责人、4 位组织管理员、1 位拥有者
# App 登录账号 18006569106（王思远）＝ 技术中心 / 应用研发部 负责人（中间层级部门）
```

账号分布：技术中心 87 人、市场中心 57 人、产品中心 28 人、职能中心 24 人；手机号用 `131` 号段顺序生成。

### 验证方法建议

App 的 adb 点击不太可靠（见 §5）。两条路：

- **让用户手点**：最省事，也最接近真实体验。
- **用 API 造数据 + App 里看**：先用 curl 建组织/成员/日程，再在 App 里刷新查看。适合验证「读」的路径。

验证完一项就改上面的状态，别攒着。

---

## 4. 环境与启动（本机是 Windows + WSL2，很多坑）

### 4.1 系统事实

- Windows + WSL2（Ubuntu 26.04），WSL 镜像网络模式（Windows 的 `localhost` 能访问 WSL 里监听的服务）。
- 用户 `jiang`，**没有 root**，`sudo` 被 `no new privileges` 拦截 → **装不了任何 apt 包，也没有 Docker**。
- WSL 内**没有 `/dev/kvm`** → 跑不了 Android 模拟器，只能用 Windows 侧的。
- 沙箱内直接调用 Windows `.exe` 会失败（vsock），**必须提权**。

### 4.2 依赖源（国际线路极慢，必须用国内镜像）

| 源 | 配置位置 | 说明 |
| --- | --- | --- |
| Maven | `~/.m2/settings.xml` | 阿里云镜像。直连 Maven Central 只有 ~20KB/s |
| npm | `~/.npmrc` | npmmirror（直连 1MB/s → 镜像 7MB/s） |
| PyPI | 命令行加 `-i https://pypi.tuna.tsinghua.edu.cn/simple` | |
| JDK/Maven 下载 | 清华 TUNA | 35MB/s，8 秒下完 |
| GitHub | 直连超时 | Expo Go 的 APK 只能让用户手动下载 |

### 4.3 工具链位置

```bash
# JDK 21 + Maven（免 root 便携版）
export JAVA_HOME=/home/jiang/tools/jdk-21.0.12.1+1
export PATH="$JAVA_HOME/bin:/home/jiang/tools/apache-maven-3.9.16/bin:$PATH"

# PostgreSQL 16.15 与 Redis 6.2.11 —— 从 Maven 仓库的嵌入式 jar 里抽出来的
# Java 测试用 zonky embedded-postgres，Python 测试复用同一份二进制
/home/jiang/.cache/xa-todo/pg/bin/          # 注意：只有服务端工具，没有 psql/createdb
/home/jiang/.cache/xa-todo/redis/redis-server

# Python 虚拟环境（本机 Python 3.14 无 pip 也无 ensurepip，用 get-pip.py 引导过）
/home/jiang/develop/xa-todo/backend-python/.venv/bin/python

# adb 包装（指向 Windows 的 adb.exe，Expo CLI 需要 PATH 里有名为 adb 的命令）
export PATH="/home/jiang/.local/bin:$PATH"
```

### 4.4 一键启动

**必须用 `setsid nohup`**，否则会话被中断时进程会被一起杀掉（已经踩过两次）。

```bash
# 1) PostgreSQL
/home/jiang/.cache/xa-todo/pg/bin/pg_ctl -D /home/jiang/.cache/xa-todo/pgdata -o "-p 5432 -k /home/jiang/.cache/xa-todo/pgsock" -l /home/jiang/.cache/xa-todo/pgdata/pg.log -w start

# 2) Redis
/home/jiang/.cache/xa-todo/redis/redis-server --port 6379 --daemonize yes --save '' --appendonly no

# 3) 后端（用 fat jar，不要用 mvn spring-boot:run，原因见 §5）
cd /home/jiang/develop/xa-todo/backend-java/xa-bootstrap
setsid nohup /home/jiang/tools/jdk-21.0.12.1+1/bin/java -jar target/xa-bootstrap-0.1.0-SNAPSHOT.jar > /tmp/xa-backend.log 2>&1 < /dev/null & disown

# 4) 模拟器（Windows 侧，需提权）
/mnt/c/Users/jiang/AppData/Local/Android/Sdk/emulator/emulator.exe -avd Medium_Phone

# 5) 端口反向映射 + Metro
export PATH="/home/jiang/.local/bin:$PATH"
adb reverse tcp:8081 tcp:8081 && adb reverse tcp:8080 tcp:8080
cd /home/jiang/develop/xa-todo/app
setsid nohup npx expo start --host localhost > /tmp/xa-metro.log 2>&1 < /dev/null & disown

# 6) 在模拟器里打开 App
adb shell am start -a android.intent.action.VIEW -d "exp://127.0.0.1:8081"
```

日志：后端 `/tmp/xa-backend.log`，Metro `/tmp/xa-metro.log`。

### 4.5 账号、重置与密钥

- 后台超管：`admin` / `admin123456`（首次启动时 `admin_user` 表为空会自动创建；生产必须改）。
- App 登录：任意合法手机号 + 验证码。**验证码会直接显示在 App 界面上**（开发环境回显 `debugCode`），也可以用 curl 发验证码接口看响应的 `data.debugCode`。
- 重置全部数据：停掉后端，然后重建库并清 Redis、清掉 App 本地令牌，最后重启后端。

```bash
# 重建数据库 + 清 Redis（单行式，避免多行缩进被 shell 解析）
/home/jiang/develop/xa-todo/backend-python/.venv/bin/python -c "import psycopg,redis; c=psycopg.connect('postgresql://postgres@localhost:5432/postgres',autocommit=True); c.execute('DROP DATABASE IF EXISTS xatodo WITH (FORCE)'); c.execute('CREATE DATABASE xatodo OWNER xatodo'); redis.Redis.from_url('redis://localhost:6379/0').flushall(); print('done')"

# 清掉 App 里保存的登录令牌
adb shell pm clear host.exp.exponent

# 然后按 4.4 重启后端（Flyway 会重建表结构并重新创建初始超管）
```

**密钥**：`~/.codex/config.toml` 里有 API key，不要提交、不要外传。

---

## 5. 环境陷阱清单（全部实际踩过，别再花时间重踩）

### 命令行

| 陷阱 | 现象 | 解法 |
| --- | --- | --- |
| `pkill -f 'xxx.jar'` 自杀 | 命令返回 143，自己的 shell 被杀掉 | 用 `ss -ltnp \| grep :8080` 找 PID 再 `kill` |
| 后台进程随会话消失 | 上一轮被中断后 PG/Redis/后端全没了 | 一律 `setsid nohup ... & disown` |
| 日志文件被覆盖 | 重启后端复用同一路径，旧日志丢了 | 重启前先 `rm -f` 或换文件名 |
| `mvn -pl xa-bootstrap spring-boot:run` | 报找不到 `com.xatodo:xa-common` | 要么先 `mvn install`，要么直接跑 fat jar |
| Python 测试起不来（`pg_ctl ... returned non-zero`） | 嵌入式 PG 要绑 **5432**，与开发库抢端口；`pg.log` 里是 `Address already in use` | 跑 pytest 前先 `pg_ctl -D ~/.cache/xa-todo/pgdata -m fast -w stop`，跑完再 start |

### Android / adb

| 陷阱 | 现象 | 解法 |
| --- | --- | --- |
| `adb.exe` 读不了 WSL 路径 | `failed to stat /mnt/c/...` | 用 `adb install -r "$(wslpath -w /mnt/c/...)"` |
| `adb shell input text` 注入多余字符 | 手机号变成 `1800656910613800002222` | 先 `KEYCODE_MOVE_END` + 多次 `KEYCODE_DEL` 清空，清空后等 1-2 秒再输入 |
| 点击落在 Expo Go 调试浮层上 | 弹出元素检查器，挡住界面并吃掉后续点击 | 先 `input keyevent KEYCODE_BACK` 关闭；坐标避开屏幕左侧与右下角的悬浮按钮 |
| 元素检查器反复出现 | 顶部 ~340px 或底部被深色横条覆盖，`input tap` 与 `input text` 全部失效，还会误触出「放弃未保存」弹窗 | 用 dev 菜单里的 **Toggle element inspector** 关掉；它一旦开着，所有 adb 自动化都不可信 |
| 模拟器里没有 `curl` / `wget` | 手工测连通性时误判为不通 | 用 `adb shell "printf 'GET / HTTP/1.0\r\n\r\n' \| nc <host> <port>"` |

### 后端 / 数据库

| 陷阱 | 现象 | 解法 |
| --- | --- | --- |
| `timestamptz` 只有微秒精度 | `scope=FUTURE` 截断序列时退让 1 纳秒被四舍五入回原时刻，截断失效 | **退让量必须 ≥ 1 毫秒**（Java 与 Python 两版都要遵守） |
| SQLAlchemy 覆盖数据库默认值 | 映射了列却没给 `server_default`，INSERT 时显式写 NULL，违反非空约束 | 凡是「值由数据库生成」的列都要声明 `server_default` |
| jsonb 列用 String 映射 | psycopg 按 varchar 发送，PG 拒绝隐式转换 | 用 `JSONB` 类型（Java 侧对应自定义 `JsonbStringTypeHandler`） |
| Python 写操作忘记 commit | **接口返回成功但数据不存在**（`get_session` 只负责关闭会话） | 每个写操作显式 `session.commit()`；Java 有 `@Transactional`，Python 没有等价物 |
| `@Transactional` + 抛异常 | 登录失败计数被一起回滚，锁定永不生效 | 登录流程不要加事务注解 |
| FastAPI 路径参数名即 URL 路径 | `device_id` 生成 `{device_id}`，与契约的 `{deviceId}` 不一致 | 参数名直接写成 `deviceId` |
| `model_dump()` 带上值为 None 的字段 | `.get(key, 默认值)` 拿到 None 而非默认值 | 先判 None 再给默认值 |

### 前端

| 陷阱 | 现象 | 解法 |
| --- | --- | --- |
| RN 的 fetch 不自动设 Content-Type | 字符串 body 默认发 `application/octet-stream`，后端 415，**所有 POST/PUT/PATCH 全挂** | 显式设 `Content-Type: application/json`。Web 端 fetch 无此问题，所以只在真机/模拟器暴露 |
| 只更新 React state 不写存储 | 登录后一重启就要重新登录 | 走 `SessionManager.setFromTokenResponse()`，别直接用 state setter |
| 未配 `tabBarIcon` | 导航栏渲染成缺字体占位方块（看起来像乱码） | 用 `@expo/vector-icons` 配上图标 |
| edge-to-edge 下内容顶到状态栏 | 去掉标题栏后内容与状态栏重叠 | 用 `useSafeAreaInsets()` 补 `paddingTop` |
| Expo Go 版本不匹配 | 找不到可用客户端 | SDK 57 对应 **Expo Go 57.0.9**。注意 `api.expo.dev` 顶层的 `androidClientUrl` 是给老 SDK 的，要读 `sdkVersions["57.0.0"]` |

---

## 6. 关键设计决策（改代码前先理解这些）

### 6.1 会话保持（spec §3.7）

- 访问令牌 **2 小时**，刷新令牌 **90 天滑动续期** → 只要 90 天内用过 App 就保持登录。
- **服务端 60 秒轮换宽限期**：旧刷新令牌被轮换后仍可复用，返回同一个新令牌。
- **客户端单飞刷新**：同一时刻只允许一个刷新请求在途，其余共享同一个 Promise。

两层保险解决同一个问题：**App 冷启动并发请求时若各自去刷新，后到的会拿着已被换掉的令牌而失败，用户就被踢到登录页**。这是「莫名其妙要重新登录」的典型成因。

### 6.2 跨语言契约（`contract/api-contract.json`）

Java 与 Python 两版后端**读同一份契约**做校验，共 83 个端点。改动等于改契约，必须两版同步。

Python 侧的覆盖率棘轮常量在 `backend-python/tests/test_contract.py`，当前 `MIN_COVERAGE_PERCENT = 100`，不允许倒退。

契约测试做两件事：① OpenAPI 覆盖全部方法与路径、安全声明与实现一致；② **实际发一次未携带令牌的请求**验证 401 行为。第 ② 点是行为验证，注解写错也会失败。

### 6.3 两版后端共享的东西

| 共享项 | 说明 |
| --- | --- |
| 数据库 schema | 由 **Flyway 独占管理**（迁移在 `backend-java` 下），Python 只读写不建表 |
| Redis 键规范 | `sms:code:{phone}`、`rt:{tokenId}`、`rt:idx:i:{identityId}` … 逐字一致 |
| JWT | 同一密钥与 claim 结构，**两版签发的令牌可互换** |
| 密码哈希 | 都用 BCrypt，互相可校验 |

因为会话状态在同一套 Redis 键下，**两版可以在同一套基础设施上灰度切换**。

### 6.4 其他

- **组织权限**：部门树用物化路径，结尾必须带斜杠（`/5/`）——否则 `/5` 会误匹配 `/51`，ID 到两位数就串权。
- **下发是快照**：下发时按范围展开为成员级记录，后续新入组成员**不补收**历史日程。
- **要求重新登录的只有 5 种情况**：主动登出、90 天未使用、账号停用、身份移除、设备被踢。

---

## 7. 工作约定

1. **spec.md 先行**：需求变更先改 spec，再改代码。
2. **提交信息写「为什么」**，不只写「做了什么」。中文。带上测试结果。
3. **提权操作**：装依赖、跑测试、调 Windows exe、写工作区外的文件都需要申请批准；优先复用已保存的 prefix rule。
4. **不要谎报完成**：没验证过就说没验证过。曾经「32 项 App 测试全绿」掩盖了两个阻断性 bug——那些测试全是 mock fetch 与 state，**真正跑起来才发现**。
5. **改了 App 就要在模拟器里看一眼**，纯逻辑测试不能代替真实运行。

---

## 8. 明确未做的（不是遗漏，是有意推迟）

| 项 | 原因 |
| --- | --- |
| 生产部署编排（Dockerfile / Nginx） | 未开始 |
| App 的提醒 UI、日程编辑/删除 UI、组织管理 UI | 只有后端接口 |
| 微信 / 邮箱绑定 | 需要微信开放平台凭证与邮件通道，属外部依赖 |
| 真实短信通道、推送（极光）、对象存储（MinIO） | 外部依赖 |
| 后台 TOTP 双因素、节假日数据 | 未开始 |
| App 的组件渲染测试 | 目前只覆盖纯逻辑层（`src/api`、`src/auth`、`src/domain`） |
| 性能验收（P95） | spec §10.5 要求但从未测过 |

---

## 9. 快速自检

```bash
# 后端（测试自带嵌入式 PG/Redis，无需外部依赖）
cd backend-java && mvn -B clean verify          # 期望 51 项全绿

# Python 后端（需要先跑 ./backend-python/scripts/setup-test-deps.sh）
cd backend-python && .venv/bin/python -m pytest  # 期望 22 项全绿

# 前端
npm run build -w @xa-todo/design-tokens
npm run build -w @xa-todo/web-admin
npm run typecheck -w @xa-todo/app
npm test                                        # 期望 7 + 15 + 32 项全绿
```

CI 在 `.github/workflows/ci.yml`，三个 job：Java / Python / 前端。
