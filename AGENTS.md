# AGENTS.md —— XaTodo 会话交接文档

> 给下一个接手这个仓库的 agent。**开工前先读完这一份**，尤其是「§3 交接清单」和「§5 环境陷阱」两节。
>
> 最后更新：2026-09-26（第三轮收尾）

---

## 0.0 本次交接摘要（2026-09-26，第三轮）

**这一轮做了什么**（对应上一轮 §3.4 的第 1、2、3 条，全部闭环）：

1. **组织管理端（Web）打通，新组织能开张了**——上一轮记的「首位成员断点」已解决：
   `/api/v1/org-admin/**` 现在**同时接受**后台 `ORG_ADMIN` 的 `ADMIN` 令牌（spec §3.2 / §4.3）。
   超管建组织时同步创建的那个后台管理员，登录 Web 组织管理端就能建部门、单个新增成员、批量导入，
   不必等组织里先有人认领。App 侧的组织身份令牌走同一前缀，权限口径一致（只限本组织）。
2. **web-admin 补齐两块页面**：组织管理端（组织设置 / 成员管理＋批量导入 / 部门管理 / 组织日历＋回执 / 操作日志）
   与意见反馈查阅（超管）；菜单按角色渲染——超管看原来的六页，组织管理员看组织那套。
3. **深色模式偏好持久化**：`app/src/theme/preference.ts` 存进安全存储，重启后仍是用户上次的选择。

顺带补齐与修掉的：

- 组织管理端缺的 6 个端点在**两版后端都实现**了，并补进契约（98 → **104** 个端点）：
  `GET /org-admin/departments`、`GET /org-admin/events`、`GET|PATCH /org-admin/settings`、
  `GET /org-admin/logs`、`GET /org-admin/imports/{id}/failures`。
- 迁移 **V15**：`event.creator_identity_id` 与 `event_dispatch.created_by_member_id` 放开非空，
  `event_dispatch` 新增 `created_by_admin_id`（后台管理员没有 C 端身份，得有人认这笔下发）。
- 组织管理端的写操作现在**真的写审计日志**（`audit_log`），所以「操作日志」页不是空壳。
- 批量导入补上权限校验（spec §2.2：导入是组织管理员权限，不是部门管理员）。
- 两处实测踩到的坑已修：①多部分请求缺 `file` 部件返回 90001（应为 400/10001）；
  ②Python 版导入模板还是老的 6 列（手机号/邮箱），已与 Java 版、spec §4.3 对齐成 4 列。

**验证证据**：Java **89** 项全绿（含契约门禁）、Python **50** 项全绿、App **84** 项 + typecheck、
web-admin **18** 项 + 生产构建；另外在真实运行环境用 HTTP 走了一遍闭环
（超管建组织 → 组织管理员建部门/导成员 → 成员认领 → 权限边界：无令牌 20001、普通成员调管理端 20003）。

**下一个 agent 从这里开始**：§3.4 只剩「拍照识别（端侧）」一条，前置条件是 Dev Client 构建环境（§4.3）。

---

### （历史）2026-09-25 第二轮摘要

**这一轮做了什么**（每条都有测试与实机证据，详见 §3）：

1. 日历页：检索（跨**个人 + 我绑定的所有组织**）、滚轮式「跳到指定日期」、常驻「今天」按钮、
   三个同尺寸悬浮按钮（拍照 / 跳转 / 新建）、节假日「休/班」标记（后端每天自动同步 holiday-cn）。
2. 账号模型改版：**登录只走个人账号**；组织账号改成「**认领**」——管理员只导入成员唯一识别 ID
   （学号/工号），成员用「组织唯一 ID + 唯一识别 ID」认领；组织 tab 常驻 + 账户管理页；
   每个组织一套独立令牌（互不串数据）。
3. 图片上传通道 + 头像换图 + 意见反馈（含超管查阅接口）；待办支持图片附件。
4. 「小安」入口落在**底部导航**（组织之后）。
5. 拍照/相册识别日程：接口、约束解码、容错解析、修复重试、可编辑结果页、地点高德解析都就绪，
   **但端侧模型没跑通**（工具链缺失），按产品要求**排到最后**。

**下一个 agent 建议从这里开始**（§3 有完整清单）：

- **【产品断点】新组织建好后没有任何入口导入首位成员**：`/org-admin/members` 要组织身份令牌，
  而新组织里还没有人认领过成员 → 无人能导入。两条路线任选（详见 §3）。
- 深色模式偏好没持久化（纯 App，很小）。
- web-admin 缺两块页面：组织管理端、意见反馈查阅（后端接口已就绪）。
- 拍照识别（端侧）——排最后，前置条件是 Dev Client 构建环境，见 §4.3 的「Android 构建链现状」。

---

## 0. 新会话开工三步（先看这里）

1. **看 §0.0 摘要与 §3 交接清单决定做什么**。需求都在 `spec.md` 里（本项目约定：需求先写 spec 再写代码）。
2. **确认环境在不在跑，在跑就别重启**：

   ```bash
   curl -s -m 5 http://localhost:8080/actuator/health   # 后端
   ss -ltn | grep -E ':5432|:6379|:8080|:8081'          # PG / Redis / 后端 / Metro
   adb devices                                          # 模拟器（需提权）
   ```

   都在跑的话直接接着干；缺哪个按 §4.4 起。**注意**：沙箱里的 `ss` 看不到宿主机进程，
   必须提权才准（这几条命令都要 `require_escalated`）。
3. **在模拟器里点之前，先关掉 Expo Go 的元素检查器**（dev 菜单 → Toggle element inspector）。
   它开着的时候会盖住顶部 ~340px 并吃掉所有 `input tap` / `input text`，还会误触出
   「放弃未保存」弹窗——我在这上面浪费过好几轮，详见 §5。

当前环境（2026-09-25 收尾时）**全部在跑**：PG 5432 / Redis 6379 / 后端 8080（带高德 Key）/ Metro 8081 / `emulator-5554`。
高德凭据在 `/home/jiang/develop/xa-todo/.env.local`（已被 gitignore）。

**后端起停脚本**（重启后端时别忘加载本地凭据，漏了会静默降级成内置地点集）：

```bash
kill "$(ss -ltnp | grep :8080 | sed -E 's/.*pid=([0-9]+).*/\1/')"   # 别用 pkill -f *.jar（会杀掉自己）
cd /home/jiang/develop/xa-todo/backend-java/xa-bootstrap
set -a; . /home/jiang/develop/xa-todo/.env.local; set +a
setsid nohup /home/jiang/tools/jdk-21.0.12.1+1/bin/java -jar target/xa-bootstrap-0.1.0-SNAPSHOT.jar \
  > /tmp/xa-backend.log 2>&1 < /dev/null & disown
```

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
| spec.md | 完成（v1.2） | — |
| 跨语言契约 | `contract/api-contract.json`，**104 个端点** | Java 与 Python 各自校验 |
| backend-java（7 模块，含新增 `xa-support`） | 完成 | **89 项集成测试全绿** |
| backend-python（FastAPI 平行重写） | 完成，**契约覆盖率 100%** | **50 项全绿** |
| packages/design-tokens | 完成 | 8 个用例（1 个测试文件；`node --test` 汇总会显示 1） |
| web-admin（React + Vite + AntD） | 完成：超管六页 + **组织管理端五页** + 意见反馈 | 18 项 |
| app（React Native + Expo） | **核心流程可用**：日程/待办增删改、地图选点、组织日程与回执、日历页检索（跨个人+所有组织）/滚轮跳转/节假日标记/拍照入口、头像上传、意见反馈、组织账号认领与账户管理、小安 tab、深色模式偏好持久化 | **84 项**（**仅纯逻辑层，组件未做渲染测试**） |

最近几次提交（倒序）：

```
035d072 feat(app): 「小安」入口移到导航栏（组织之后）；拍照识别整条暂缓到最后
3a63dfc feat: 检索跨「个人 + 我绑定的所有组织」；日历页加拍照与小安入口；取消不再二次确认
d8bab0b fix(app): 「今天」按钮改成三栏布局，不再压住上一月的箭头
147ecf2 fix(app): 两个悬浮按钮统一成 56×56
7e40740 feat(app): 「跳到指定日期」改成滚轮选日期，不再复用月历
c07b579 feat(app): 登录只走个人账号、组织 tab 常驻、新增「账户管理」
52fb38f fix(org): 同一账号在同一组织只能绑一个成员账号——复用时先查占用
59f5f66 feat(org): 组织账号改为「认领」模型——登录只走个人账号，组织账号可绑定多个
d6745d6 docs(agents): 交接上传/头像/反馈与节假日自动同步，并记下两个真坑
8c51d22 feat: 图片上传通道 + 头像换图 + 意见反馈；节假日改为后端每天自动同步
abe6b3e feat: 日历页检索、跳到指定日期、节假日/调休标记，并修掉月历多画一整周邻月
```

---

## 3. 交接清单（已完成 / 未做完 / 已知问题）

**这一节怎么读**：3.1 本轮做完的（都有实机证据）→ 3.2 节假日数据约定 →
3.3 组织账号模型（**本轮最大的改动，动手前必读**）→ **3.4 未做完的（先从这里挑活）** →
3.5 未走查的界面 → 3.6 实现细节 → 3.7 模拟企业数据集 → 3.8 验证方法 →
3.9 上一轮的验证记录（历史，已闭环）。

### 3.1 本轮已完成（2026-09-25 第二轮，代码 + 测试 + 模拟器实机都走过）

| # | 需求 | 落地位置 | 证据 |
| --- | --- | --- | --- |
| 1 | **日历页置顶搜索框**（同时搜日程与待办） | 契约新增 `GET /search`；Java `SearchService` / Python `SearchService`；App `AgendaScreen` 顶部常驻搜索框 | Java `SearchAndHolidayTest` 7 项 + Python 同名 7 项；模拟器输入 `A` 命中地点「会议室 A」的日程，带「重复」徽标；curl 验证重复日程落在最近一次实例（`occurrenceDate=2026-09-28`） |
| 2 | **「跳到指定日期」**（新建按钮上方的悬浮按钮） | 纯 App，`AgendaScreen` 里的 `jumpLayer`（复用月历组件，含「回到今天」） | 模拟器点开、翻月、选中均正常 |
| 3 | **节假日与调休显示**（格子标「休 / 班」） | 契约新增 `GET /holidays`；表 `holiday`（V11 只建表）；数据源 `scripts/data/holidays/*.json` + `scripts/load_holidays.py` 热更新；App `MonthCalendar` 在数字右上角画休（蓝）/班（红） | 2026 年 39 条真实数据（33 放假 + 6 调休）；模拟器 9/25「休」、9/20「班」可见；详见 §3.2 |
| 4 | **图片上传通道**（头像与反馈的前置，spec §5.10） | 契约新增 `POST /uploads/images`；新增 `xa-support` 模块里的 `ImageStorage`（按文件头判格式、内容哈希命名、目录可配）+ `/uploads/**` 静态映射（免鉴权） | Java `SupportModuleTest` + Python 同名用例：伪装成 jpg 的文本被 `90003` 拒、超 5 MB 被 `90004` 拒、同图重复上传得同一 URL、静态目录能取图 |
| 5 | **头像上传/更新**（spec §4.1.8） | App「我的」页头像可点：选图 → 上传 → `PATCH /me` 回填；`avatarUrl` 存相对 URL，展示时拼 API 地址（`domain/media.ts`） | 模拟器实机换头像成功；`GET /me` 返回 `/uploads/610f05….png`，该地址免鉴权取回 `image/png` |
| 6 | **意见反馈**（spec §4.1.9 / §5.10 / §6.3） | 契约新增 `POST /feedback`、`GET /feedback`、`GET /admin/feedback`、`POST /admin/feedback/{id}/handle`；迁移 V12 建 `feedback` 表；App 新增整页表单（分类 + 描述 + 多图 + 历史） | 模拟器提交成功且历史可见；超管列表能看到并标记 `HANDLED`，处理后再查待处理列表为 0 |
| 7 | **检索跨「个人 + 我绑定的所有组织」**（spec §4.1.7） | `/search` 增加 `ORG_EVENT` 类型 + `identityId`/`orgId`/`orgName`；App 点组织日程会切到对应组织视图并选中那天 | Java `OrgModuleTest.searchCoversOrgEventsAcrossBoundOrganizations`（同一账号绑两个组织 → 命中两条 → 撤回一条后只剩一条）+ Python 同名用例 |
| 8 | **组织账号「认领」模型**（spec §3.1 / §3.2 / §4.2.5，这一轮最大的改动） | 登录只走个人账号；`POST /org-accounts/login`（组织唯一 ID + 成员唯一识别 ID）；`GET/DELETE /org-accounts`；组织 tab 常驻 + 账户管理页；每个组织一套独立令牌 | Java 87 项里的 `OrgModuleTest` / `AuthFlowTest` 相关用例；模拟器实机：组织 tab 自动重新认领 → 显示「当前组织 心安科技」+ 组织日程与回执；账户管理页可添加/列表/删除 |
| 9 | **「小安」入口**（spec §11 阶段三的预留位） | 底部导航常驻 tab，排在「组织」之后，标题就叫「小安」；对话页如实说「还没有接入模型」 | 模拟器截图；`app/test/agent.test.ts` 有用例盯着「未接入」的文案 |
| 10 | **待办图片附件**（spec §4.1.3） | 迁移 V14 `task.images`；`POST/PATCH /tasks` 接受 `images[]` | Java/Python 都测了「外链被拒」「空数组=删光（不能只看接口返回，要 GET 读回来）」 |
| 11 | **取消不再二次确认**（spec §4.1.5） | 编辑页「取消」直接返回；删除这类不可恢复操作仍然确认 | — |

顺带修掉一个实机发现的问题：**月历固定画 6 行**会把整周属于邻月的日子也画进来（9 月视图里出现一整周 10 月）。
现在按实际需要的行数渲染（5 或 6 行），`buildMonthGrid` 有专门的回归测试（`app/test/calendar.test.ts`）。

### 3.1.1 第三轮已完成（2026-09-26，代码 + 两版后端测试 + 真实环境 HTTP 走通）

| # | 需求 | 落地位置 | 证据 |
| --- | --- | --- | --- |
| 1 | **组织管理端入口（原「首位成员断点」）** | `AdminAuthenticationFilter` 现在也处理 `/org-admin/**`；新增 `xa-auth.AdminActor` 接口 + `xa-org.OrgActor` 执行者；`OrgPermissionService.resolveActor()` 同时认「组织身份」与「后台 ORG_ADMIN」；Python 侧 `deps.current_org_actor` + `OrgService.resolve_actor` | Java `OrgModuleTest.orgAdminConsoleCanOpenUpANewOrganization`（新组织 0 成员 → 建部门 → 新增成员 → 批量导入 → 成员认领 → 后台下发日程 → 操作日志）+ `orgConsoleTokenIsScopedAndMemberIsRejected`；Python 同名 2 项；真实环境 HTTP 冒烟：超管建组织 → 组织管理员建部门/成员 OK，成员令牌调管理端 20003、无令牌 20001 |
| 2 | **web-admin 组织管理端** | `pages/OrgSettingsPage / OrgMembersPage（含批量导入与失败明细）/ OrgDepartmentsPage / OrgEventsPage（含回执抽屉）/ OrgLogsPage`；`AppLayout` 按角色渲染菜单 | `npm run build -w @xa-todo/web-admin` 通过；`OrgMembersPage.test.tsx` 盯着「已认领 / 待认领」与两个入口按钮 |
| 3 | **web-admin 意见反馈查阅** | `pages/FeedbackPage`（默认只看待处理，可切已处理/全部，图片预览，标记已处理） | `FeedbackPage.test.tsx`：默认 `status=OPEN`、处理后重新拉列表 |
| 4 | **深色模式偏好持久化** | `app/src/theme/preference.ts`（安全存储 + `nextScheme`），`AppContext` 启动时读回、切换时写回 | `app/test/themePreference.test.ts` 3 项；App 84 项 + typecheck 通过 |
| 5 | **组织管理端缺的端点补齐**（契约 98 → 104） | `GET /org-admin/departments`、`GET /org-admin/events`（带回执分布）、`GET\|PATCH /org-admin/settings`、`GET /org-admin/logs`、`GET /org-admin/imports/{id}/failures`；Java 与 Python 两版都实现 | Java `OpenApiContractTest` 4 项通过（覆盖 + 安全声明 + 未带令牌 401） |
| 6 | **组织管理端的审计日志** | 新增 `OrgAuditSink`（定义在 xa-org，实现在 xa-admin，避免 xa-org 反向依赖）+ `OrgAuditRecorder`；Python 侧 `OrgService.record_org_audit`；在 controller/router 层逐端点记录 | 冒烟测试里 `GET /org-admin/logs` 返回 `ORG_DEPARTMENT_CREATE`、`ORG_MEMBER_CREATE` |
| 7 | **V15 迁移** | `event.creator_identity_id`、`event_dispatch.created_by_member_id` 放开非空；`event_dispatch` 新增 `created_by_admin_id` + CHECK（发起方恰有一列非空） | 开发库启动日志：`Successfully applied 2 migrations ... now at version v15` |
| 8 | 顺带修 | ①多部分请求缺 `file` → 现在 400/10001（原来掉进兜底返回 90001）；②批量导入补 `requireOrgAdmin`（spec §2.2）；③Python 导入模板从老的 6 列改回 4 列，与 Java 版和 spec §4.3 一致 | 冒烟时实测到 90001 才发现的第①条；②有 Java/Python 用例；③两版 `template()` 现在同列 |

### 3.2 节假日数据（2026-09-25 的新约定，别搞混）

- 数据**不在迁移里、不在代码里**。`V11__holiday_calendar.sql` 只建表；上游是
  [holiday-cn](https://github.com/NateScarlet/holiday-cn)（含国务院办公厅通知链接）。
- **两版后端每天自动同步**（默认 03:10 东八区，启动后 30 秒再补跑一次）：拉当年与次年、幂等 upsert、
  清缓存，所以更新完立刻可见。配置项 `HOLIDAY_SYNC_ENABLED / HOLIDAY_SYNC_CRON / HOLIDAY_SYNC_BASE_URL`；
  测试里被 surefire 系统属性与 conftest 关掉——单元测试不该依赖外网。
- 离线 / CI / 想立刻生效时手动灌：`backend-python/.venv/bin/python scripts/load_holidays.py`
  （`--url` 拉指定年份、`--prune` 清理上游撤掉的日子）。
- 同步状态在 `GET /system/info` 的 `holidaySync` 里（`lastSuccessAt` / `lastError` / `years`）——
  后台任务静默失败是最难查的故障。
- 库里没有那一年就是空数组、界面不显示任何标记——**不猜、不硬编码兜底**。

### 3.3 组织账号模型（2026-09-25 改版，动手前务必读 spec §3.1 / §3.2 / §4.2.5）

- **登录只走个人账号**：`POST /auth/login/sms`（要带 `deviceId`）已有个人身份时直接返回个人会话；
  `selectToken` / 选身份页在 App 里已经删掉（端点还留着，给将来的 Web 端）。
- **组织账号是「认领」出来的**：组织管理员导入成员时**只写成员唯一识别 ID**
  （`member_key`，学号/工号，泛化统称 memberKey），不写手机号、不设密码；
  成员在 App「组织 tab → 账户管理」里用 **组织唯一 ID（组织编码或数字 ID）+ 唯一识别 ID**
  认领，认领成功即为绑定，同时返回该组织身份的令牌对。
- 一个个人账号可绑多个组织账号（跨组织）；**同一组织只能绑一个成员账号**（`uk_org(account_id, org_id)`）；
  已被别人认领的成员，其他人认领会被拒，恢复路径是**组织管理员解绑**
  `POST /org-admin/members/{id}/unbind`。
- **两套上下文**：个人身份令牌管日历/待办/我的；每个组织各有一份自己的令牌管组织 tab。
  App 侧把每个组织的令牌存进安全存储（`xa-todo.org-accounts`），进入组织视图时用它，
  切组织就是整套换令牌——**不同组织的视图必须互不串数据**。
- 组织 tab **常驻**：没绑任何组织账号时展示空状态 + 添加入口（入口消失用户就找不到地方加了）。
- 安全取舍：唯一识别 ID 不是秘密，所以这是「认领」而非强认证（spec §3.1 写了加固方向）。

### 3.4 未做完的（按建议顺序）

| # | 事项 | 说明 |
| --- | --- | --- |
| 1 | **拍照 / 相册识别日程**（spec §4.1.9）：契约、约束解码、容错解析、修复重试、App 的拍照/相册入口与可编辑确认页、地点高德解析都已就绪并有测试 | **端侧模型未跑通**：端侧推理要 Dev Client 构建（原生模块 + Android NDK/CMake），本机工具链不具备（Windows SDK 无 ndk/cmake/cmdline-tools、WSL 无 gcc）。**产品要求排到最后再做**；未配模型时接口如实返回 90002 |
| 2 | （待产品定，非阻塞）超管建组织时**预置首位拥有者成员** | 上一轮列的「路线①」。现在**路线②已落地**（见 §0.0 第 1 条），所以这条只是可选增强：预置能让组织一建好就有一个可认领的拥有者，不必先在后台手工建。若要做：组织创建请求体加 `ownerMemberKey`/`ownerRealName`，两版后端 + 契约 + 超管建组织表单同步改 |
| 3 | App 侧没有组织成员管理界面 | spec §4.3 把成员/部门管理划给 Web 组织管理端，App 只有组织日历与回执（§4.2）。这是设计如此，不是遗漏；如果产品要求「拥有者在手机上也能导成员」，得先改 spec |

App 侧选图用 `expo-image-picker`，取文件用 `expo-file-system` 的 `File`（原因见 §5 陷阱里的
「Expo SDK 57 的 fetch 不支持 `{uri,name,type}`」）。

### 3.5 App 界面未走查的部分（代码完成、测试绿，但没在模拟器里逐屏点过）

- 待办的图片附件（拍照入口 → 结果页）在**未接入模型**时的表现：只验到「如实提示」这一层，
  真正识别、编辑、批量创建这条链路没跑通过（端侧模型未就绪，见 §3.4 第 4 条）。
- 意见反馈的历史列表在数据较多时的滚动表现；「我的」页深色模式下的观感。
- **第三轮新增、只在真实环境用 HTTP 验过、没在浏览器里点过的**：web-admin 组织管理端五页 +
  意见反馈页（构建与组件测试都过，但没有人在浏览器里逐屏走过）。
- **深色模式持久化只验到「存储读写 + 切换逻辑」**（单测），没在模拟器里做到「杀掉 App 再冷启动仍是深色」。
  上一次实测这个行为的成本不低（Expo Go 的检查器坑，见 §5），建议让用户手点确认。

原因见 §5：Expo Go 的元素检查器会反复出现并吃掉点击，adb 自动化在它开着时不可信；
另外**用 adb 点按钮前先 `uiautomator dump` 拿真实 bounds**，别凭截图估算坐标（我因此白点了几轮）。

### 3.6 已完成但值得记住的实现细节

- **地图选点页由后端提供**（`/map/amap`），不是 App 内联 HTML：内联走 Android 的 `loadDataWithBaseURL`，高德 JS API v2 能下到脚本却**不定义 `AMap`**；换成真实 HTTP 页面才正常。页面内「拿到位置前不建图」，否则会先闪一个默认城市再跳过去。
- **GPS 的 WGS-84 必须转 GCJ-02 再落点**（页面里用 `AMap.convertFrom`），直接画会偏几百米。
- 高德两类 Key 分工：**Web服务** Key 给后端搜地点/逆地理（不出服务端）；**Web端(JS API)** Key + 安全密钥给 WebView 画地图（必然在客户端）。`scripts/check_amap_key.sh` 可一键验证。
- 日程编辑与新建共用同一个整页组件；重复日程的保存/删除会询问「仅此一次 / 整个系列」。
- `PATCH /events/{id}` 的 null 语义是「不修改」，**空串才是「清空」**（地点尤为明显：清空时坐标一并清掉）。
- **`/org-admin/**` 有两个入口，别只想到一个**：App 组织身份的 `ACCESS` 令牌，以及后台 `ORG_ADMIN`
  的 `ADMIN` 令牌（spec §3.2）。实现上是两个过滤器都尝试解析，谁解析成功谁写上下文；
  `OrgPermissionService.resolveActor()` / Python `current_org_actor` 再把主体转成统一的「组织执行者」
  （后台管理员没有 `org_member` 记录，`memberId`/`identityId` 为空、部门范围是整个组织）。
  唯一例外是 `GET /org-admin/logs`：它只服务后台管理员（App 里没有这个页面）。
- **组织管理端的审计出口是接口倒置的**：`audit_log` 的实体/mapper 在 `xa-admin`，而管理操作发生在 `xa-org`，
  且 `xa-org` 不能反向依赖 `xa-admin`。因此 `xa-org` 只声明 `OrgAuditSink`，由 `xa-admin.AdminOrgAuditSink`
  实现，运行时经 `OrgAuditRecorder`（`ObjectProvider`，没有实现时静默跳过）注入。
- **可管理部门集合不要缓存成快照**：批量导入会在过程中自动补建部门，执行者对象里那份集合会立刻过期，
  结果「刚建出来的那一层把自己挡住了」。`requireCanManageDepartment(OrgActor, …)` 每次都按库里当前结构重算
  （Python 侧天然每次查库，没有这个问题）。

### 3.7 模拟企业数据集

`scripts/seed_demo_org.py` 可重复执行（按组织编码 / 部门路径 / 手机号判重），一键造出一家模拟大型企业：

```
backend-python/.venv/bin/python scripts/seed_demo_org.py
# 组织 #1 心安科技(XATECH)：43 个部门（中心→部→组 三层）、196 名成员、43 位部门负责人、4 位组织管理员、1 位拥有者
# App 登录账号 18006569106（王思远）＝ 技术中心 / 应用研发部 负责人（中间层级部门）
```

账号分布：技术中心 87 人、市场中心 57 人、产品中心 28 人、职能中心 24 人；手机号用 `131` 号段顺序生成。
**注意**：该脚本直接写库，绕过了「组织成员没有导入入口」这个断点（见 §3.4 第 1 条）。

### 3.8 验证方法建议

App 的 adb 点击不太可靠（见 §5）。两条路：

- **让用户手点**：最省事，也最接近真实体验。
- **用 API 造数据 + App 里看**：先用 curl 建组织/成员/日程，再在 App 里刷新查看。适合验证「读」的路径。

验证完一项就回来改文档里的状态，别攒着。

### 3.9 上一轮的验证记录（2026-09-25 第一轮，5 项全部实机通过）

那一轮被明确批评「做一件事忘了上一件」，所以清单从「代码写完」改判为「实机走通」才算数。
证据都在后端日志与数据库里，不是"看起来应该行"。

| # | 事项 | 验证结论 | 状态 |
| --- | --- | --- | --- |
| 1 | **新建日程全流程** | 点 `+` → 表单弹出 → 填标题 → 保存 → 列表立即出现「Team 09:00–10:00」；数据库 `event id=1` 落库（Asia/Shanghai，CONFIRMED） | ✅ 通过 |
| 2 | **会话持久化** | `am force-stop` 杀掉 Expo Go 后冷启动，直接进入日历页并加载出个人日程，**未要求重新登录** | ✅ 通过 |
| 3 | **待办页** | 输入框回车新增 →「待办 1 条」；勾选后条目移入「已完成」分组、标题加删除线 | ✅ 通过 |
| 4 | **我的页** | 深色模式整屏切换正常；身份切换成功（个人 ↔ 组织）——**当时的「选身份页」在第二轮已被「常驻组织 tab」取代**，见 §3.3 | ✅ 通过 |
| 5 | **组织身份全链路** | 超管建组织 → 组织身份下发日程（部门范围展开 **35** 条成员级记录）→ App 切组织身份看到「季度技术评审会」→ 点「参加」→ `event_recipient.receipt_status=ACCEPTED` 落库 | ✅ 通过 |

那一轮还记了 4 条已知问题，现状如下（结论都已并进前面几节，这里只做对照，避免以后当成"没人提过"）：

| 上一轮记的问题 | 现在的状态 |
| --- | --- |
| 组织首位成员无法创建（鸡生蛋） | 仍在（换了形态），见 §3.4 第 1 条 |
| 深色模式偏好没有持久化 | 仍在，见 §3.4 第 2 条 |
| App 端地图受 Expo Go 限制 | ✅ 已解决：WebView + 后端页 `/map/amap`，见 §3.6 第 1 条 |
| web-admin 没实现组织管理端 | 仍在，见 §3.4 第 3 条 |

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

**Android 构建链的现状（2026-09-25 实测，做端侧/原生模块前先看这条）**：

| 项 | 状态 |
| --- | --- |
| Windows 侧 Android SDK（`/mnt/c/Users/jiang/AppData/Local/Android/Sdk`） | 有 `build-tools/36.0.0`、`platforms/android-37.0`、`platform-tools`、`emulator`、`system-images` |
| **NDK / CMake / cmdline-tools** | **都没有**（`Sdk/ndk`、`Sdk/cmake`、`Sdk/cmdline-tools` 均不存在）→ 编译原生模块（如 `llama.rn`）目前做不到 |
| WSL 侧 | 没有 `gcc/g++/make/cmake/ninja`，也没有 `sudo` → 不能在本机编译原生代码 |
| 网络 | `huggingface.co` / `hf-mirror.com` / `dl.google.com` / `services.gradle.org` 可达；**GitHub 直连不稳**（时通时超时） |
| 磁盘 | WSL 947G 可用、C: 302G 可用 |

要装 NDK/CMake：Windows 侧用 Android Studio 的 SDK Manager 勾上（最快），
或从 `dl.google.com` 下 zip 解进 SDK 目录（没有 cmdline-tools，`sdkmanager` 用不了）。

### 4.4 一键启动

**必须用 `setsid nohup`**，否则会话被中断时进程会被一起杀掉（已经踩过两次）。

```bash
# 1) PostgreSQL
/home/jiang/.cache/xa-todo/pg/bin/pg_ctl -D /home/jiang/.cache/xa-todo/pgdata -o "-p 5432 -k /home/jiang/.cache/xa-todo/pgsock" -l /home/jiang/.cache/xa-todo/pgdata/pg.log -w start

# 2) Redis
/home/jiang/.cache/xa-todo/redis/redis-server --port 6379 --daemonize yes --save '' --appendonly no

# 3) 后端（用 fat jar，不要用 mvn spring-boot:run，原因见 §5）
cd /home/jiang/develop/xa-todo/backend-java/xa-bootstrap
# 先加载本地凭据（高德 Key）——**漏了这步不会报错**，只是地点服务静默降级成内置地点集，
# 表现是「搜不到真实 POI / 地图空白」，很容易误判成代码问题
set -a; . /home/jiang/develop/xa-todo/.env.local; set +a
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

**重建库后节假日数据会自动回来**（两版后端每天同步 + 启动后 30 秒补跑一次，见 §3「节假日数据」）。
要立刻生效、或环境没有外网时，手动灌：

```bash
backend-python/.venv/bin/python scripts/load_holidays.py
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
| Java 测试报 `SocketException: Operation not permitted` | 沙箱不允许绑监听端口，嵌入式 PG/Redis 起不来（表现为 `ApplicationContext failure`，看 surefire 报告里真正的 `Caused by`） | `mvn -B clean verify` 要提权；开发库不用停（zonky 用随机端口） |
| 关键词检索里的 `%` / `_` | 不转义就成了通配符：搜「50%」命中所有日程，即「搜什么都灵」 | SQL 写 `ILIKE :pattern ESCAPE '\'`，Java/Python 两边都要把 `\ % _` 转义；行为有测试守着 |
| Python 套件里无关用例报「验证码发送次数已达上限」 | 按 **IP** 的日限额在测试里没有意义（TestClient 的 client_ip 恒为 `testclient`，**整个套件共用一个计数器**），用例一多就随机变红 | `tests/conftest.py` 已把 `SMS_DAILY_LIMIT_PER_IP` 放开；手机号维度限额保持不变 |
| **Java 测试类里手机号必须全类唯一** | 同一个号被两个用例注册 → 第二次撞 60 秒发送频控（`20005`），报的却是「发送过于频繁」，看不出是自己重号 | 新增用例前先 `grep -c "1380000xxxx"` 数一遍；Java 侧同时也把按 IP 的日限额在 surefire 里放开了（`xatodo.auth.sms-daily-limit-per-ip=100000`） |
| Python 测试在**导入期**就 `import` 了 app 模块 | `app.config` 会在 conftest 设 `DATABASE_URL` 之前读进内存 → 整套用例跑去连开发库（报 `role "xatodo" does not exist`） | 测试里**在用例函数内部**导入 `app.services.*`（`tests/test_vision.py` 顶部就是这么注释的） |
| 断言「空字段会消失」 | `non_null` 序列化只对 **null** 生效；空数组仍会返回 `[]`，我按 `isMissingNode()` 断言就红了 | 清空类断言写「返回空数组」而不是「字段不存在」 |
| **沙箱内 `curl localhost:8080` 连不上** | 服务其实好好的（`ss -ltnp` 能看到 `*:8080` 在监听），只有沙箱里的 curl 连不上，很容易误判成「后端挂了」 | 判断服务在不在，一律**提权**跑 `ss -ltnp` / `pgrep -af`；别用沙箱内的 curl 下结论 |
| `multipart` 请求漏了 `file` 部件 | 返回 **90001**（服务内部错误），看着像后端炸了，其实只是参数没给 | 已修：`GlobalExceptionHandler` 现在把 `MissingServletRequestPartException` 映射成 400 / `10001`；Python 侧 FastAPI 的 `RequestValidationError` 处理器本来就有 |

### Android / adb

| 陷阱 | 现象 | 解法 |
| --- | --- | --- |
| `adb.exe` 读不了 WSL 路径 | `failed to stat /mnt/c/...` | 用 `adb install -r "$(wslpath -w /mnt/c/...)"` |
| `adb shell input text` 注入多余字符 | 手机号变成 `1800656910613800002222` | 先 `KEYCODE_MOVE_END` + 多次 `KEYCODE_DEL` 清空，清空后等 1-2 秒再输入 |
| 点击落在 Expo Go 调试浮层上 | 弹出元素检查器，挡住界面并吃掉后续点击 | 先 `input keyevent KEYCODE_BACK` 关闭；坐标避开屏幕左侧与右下角的悬浮按钮 |
| 元素检查器反复出现 | 顶部 ~340px 或底部被深色横条覆盖，`input tap` 与 `input text` 全部失效，还会误触出「放弃未保存」弹窗 | 用 dev 菜单里的 **Toggle element inspector** 关掉；它一旦开着，所有 adb 自动化都不可信 |
| 模拟器里没有 `curl` / `wget` | 手工测连通性时误判为不通 | 用 `adb shell "printf 'GET / HTTP/1.0\r\n\r\n' \| nc <host> <port>"` |
| `adb shell input text` 打不了中文 | 想验证「搜索框」却输不进关键字 | 用 ASCII 关键字验证（例如地点名里的字母），或用 App 里已有的中文数据反查 |
| 日历/月视图固定画 6 行 | 9 月视图里出现**一整周 10 月**——那一周一天都不属于 9 月 | `buildMonthGrid` 按实际需要渲染 5/6 行，`app/test/calendar.test.ts` 有回归测试；注意 1 基月份别当 0 基传给 `Date.UTC` |
| **凭截图估算坐标去 adb 点按钮** | 我点「确定/取消/回到今天」连点三轮都没反应，以为是按钮坏了——实际 y 高了 70px，落在那上面一列滚轮的命中区里，只改了草稿 | 点之前先 `adb shell uiautomator dump` 拿真实 `bounds`，或直接看 `content-desc`；这台机器上滚轮列的可点范围比视觉高度更大 |
| 绝对定位的按钮压住同类控件 | 「今天」按钮绝对定位在月历头部左侧，正好压在上一月的 `‹` 上，两个可点区域重合 | 宁可改成规整三栏（左/中/右留等宽占位），也别用绝对定位往已有控件上叠 |
| 横向 `ScrollView` 没定高 | 建议问法那排把整屏高度吃掉（它按内容撑满剩余空间） | 给横向滚轮/胶囊行显式 `style={{ flexGrow: 0, maxHeight: 48 }}` |
| Expo Go 里引用原生模块 | `require('llama.rn')` 这类静态引用会让 Metro 在打包阶段就失败（不是运行时报错） | 端侧模块用**注册制**：`vision/onDevice.ts` 只放接口 + `registerOnDeviceEngine`，Dev Client 构建里再注册实现；Expo Go 下自动回落到服务端识别 |

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
| **MyBatis-Plus `updateById` 默认忽略 null 字段** | 「清空截止时间 / 取消完成 / 清空地点」接口返回成功，**库里根本没改**——最阴的一类 bug，只看接口返回永远发现不了 | 需要写 null 的字段加 `@TableField(updateStrategy = FieldStrategy.ALWAYS)`（3.5.17 里旧名 `IGNORED` 已移除）；**测试必须重新 GET 读回来验证**，不能断言更新接口的返回体（那是内存对象，会假通过） |
| Python `(:param IS NULL OR ...)` 不写类型 | 参数为 None 时 PG 报 `AmbiguousParameter`，接口直接 500（`GET /tasks` 不带 status 就是这样） | 写成 `CAST(:param AS text)`；别依赖 PG 推断 |
| `List.of(null)` / `Map.of().get(null)` | 抛 NPE。未关联日程的待办一查列表就 500 | 用 `Collections.emptyMap()`，或在取之前判 null |
| Python 测试夹具按**字典序**排迁移文件 | `V10__` 排在 `V4__` 前面 → task 表还不存在就 `ALTER TABLE`；只在版本号进两位数后暴露 | 按版本号**数值**排序（与 Flyway 一致），见 `tests/conftest.py::_migration_version` |
| 后端 `default-property-inclusion: non_null` | 空字段**整个消失**，前端拿到的是 `undefined` 而不是 `null`，`!== null` 判断全部走偏 | 在前端边界归一到 `null`（`?? null`） |
| 时间用 `toLocaleString` 不带 `timeZone` | 跟**设备时区**走。设备不是东八区时，同一时刻日历页显示 14:00、待办页显示 06:00，两页自相矛盾 | 统一显式传 `timeZone: APP_TIMEZONE` 再格式化 |
| 上传的文件名用用户给的名字 | 路径穿越 + 同名覆盖 + 无法去重 | 文件名取**内容哈希**（`ImageStorage`），原始文件名只出现在 multipart 的 filename 提示里；格式按**文件头**判定，不信客户端声明的 MIME |
| `/uploads/**` 忘了免鉴权 | `<Image>` 直接按 URL 取图，带不了 Authorization，图全裂 | `SecurityConfig` 放行 `/uploads/**`（Java 静态映射 / Python `StaticFiles`）；代价是这里不能放私有内容 |
| 节假日「更新了但界面没变」 | 数据入库了，进程内缓存还在，界面仍是旧的 | 同步成功后主动 `clearCache()`；平时 TTL 5 分钟兜底 |

### 前端

| 陷阱 | 现象 | 解法 |
| --- | --- | --- |
| RN 的 fetch 不自动设 Content-Type | 字符串 body 默认发 `application/octet-stream`，后端 415，**所有 POST/PUT/PATCH 全挂** | 显式设 `Content-Type: application/json`。Web 端 fetch 无此问题，所以只在真机/模拟器暴露 |
| Expo SDK 57 的 fetch 不支持 `FormData.append(name, { uri, name, type })` | 上传图片时报 `Unsupported FormDataPart implementation`，请求根本不出网（后端日志里什么都看不到） | Expo 的 fetch 自己拼 multipart，只接受 **Blob** 或带 `bytes()` 的对象：用 `expo-file-system` 的 `File`（实现 Blob 接口、自带 name/type）append。见 `api/endpoints.ts` 的 `uploadImage` |
| `ImagePicker` 开 `allowsEditing: true` | 拉起 AOSP 裁剪页，但这台模拟器上**确认按钮不渲染**（只有翻转菜单），用户卡在裁剪页出不来 | 头像这类「界面里本来就圆形裁切」的场景别开；真需要裁剪就自己实现 |
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

Java 与 Python 两版后端**读同一份契约**做校验，共 **104 个端点**。改动等于改契约，必须两版同步。

> 组织管理端的 6 个端点（`GET /org-admin/departments`、`GET /org-admin/events`、`GET|PATCH /org-admin/settings`、
> `GET /org-admin/logs`、`GET /org-admin/imports/{id}/failures`）是 2026-09-26 补上的：
> spec §6.3 早就写了它们，但契约与两版实现都漏了——**spec 是唯一事实来源，它写了就得有**。

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
| App 的提醒 UI | 只有后端接口 |
| App 侧的组织成员/部门管理 | spec §4.3 把这块划给 Web 组织管理端；App 只有组织日历与回执（是设计，不是遗漏） |
| 微信 / 邮箱绑定 | 需要微信开放平台凭证与邮件通道，属外部依赖 |
| 真实短信通道、推送（极光）、对象存储（MinIO） | 外部依赖 |
| 后台 TOTP 双因素 | 未开始 |
| 端侧多模态模型（拍照识别日程里的识别环节） | 需要 Dev Client 构建环境（缺 NDK/CMake，见 §4.3）；产品已把这个功能排到最后 |
| App 的组件渲染测试 | 目前只覆盖纯逻辑层（`src/api`、`src/auth`、`src/domain`） |
| 性能验收（P95） | spec §10.5 要求但从未测过 |

---

## 9. 快速自检

```bash
# 后端（测试自带嵌入式 PG/Redis，无需外部依赖）
cd backend-java && mvn -B clean verify          # 期望 89 项全绿（需提权：沙箱不让绑端口）

# Python 后端（需要先跑 ./backend-python/scripts/setup-test-deps.sh）
# 注意：嵌入式 PG 要占 5432，跑之前先停开发库，跑完再启回来
cd backend-python && .venv/bin/python -m pytest  # 期望 50 项全绿

# 前端
npm run build -w @xa-todo/design-tokens
npm run build -w @xa-todo/web-admin
npm run typecheck -w @xa-todo/app
npm test                                        # 期望 design-tokens 8 例 + web-admin 18 项 + app 84 项全绿
```

CI 在 `.github/workflows/ci.yml`，三个 job：Java / Python / 前端。
