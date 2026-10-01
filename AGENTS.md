# AGENTS.md —— 时纪流（ChronoFlow）会话交接文档

> 给下一个接手这个仓库的 agent。**开工前先读完这一份**，尤其是「§3 交接清单」和「§5 环境陷阱」两节。
>
> 最后更新：2026-10-01（第十四轮：**图片识别日程改走服务端解析** —— 只抽「要你做的事」、
> 日期可有可无、确认页补全后一键添加；端侧小模型从包里拿掉）
>
> ⚠️ **数据模型变了**：`event.start_at` / `event.end_at` 已被 V18 迁移合并成 `event.at`（单时间点），
> 不再有起止与时长；`event_exception.override_*` 同样合成 `override_at`。
> 两版后端、Web 组织管理端与 App 都已对齐。改动前先读 §0.0 第九轮摘要。

---

## 0.0 本次交接摘要（2026-10-01，第十四轮：图片识别日程改走服务端解析 + 确认页）

上一轮接端侧小模型（`llama.rn` + 0.5B GGUF）没接完，这一轮**换掉整个方向**：解析交回服务端，
端侧只做 OCR。理由与结论都记在 §0.0 第十三轮末尾的追加里，这里只列**改动与口径**。

| # | 内容 |
| --- | --- |
| 1 | **抽取口径重写**：`agent/vision-prompt.md`（Java / Python **逐字节相同**）改成「只抽**要你做的事**」（登记 / 报名 / 交材料 / 开会 / 缴费…），叙述性内容（放假区间、「@所有人」「各部门」抬头、情况统计的说明）不抽；**日期有就写、没有就留空**，不拿今天兜底、不猜时刻（只说了哪天 → 当天 00:00，「上午」不折算成 09:00）。 |
| 2 | **`POST /ai/events/parse-text` 返回形状变了**：`{ items:[{ title, at?, timezone, locationName?, description? }] }` —— 去掉 `kind` / `confidence`，新增 `timezone`（客户端靠它判定「00:00 = 只说了哪天」）；**`at` 为空是合法返回**（通知里没写日期），不得因为缺日期就丢条目。两版后端都把调用改成**结构化输出**：`response_format=json_object` + `temperature=0`（Java：`CompletionRequest.structured(...)`；Python：`AgentModelClient.complete_json`）。 |
| 3 | **Python 版补齐**：`app/services/vision_text.py` + `app/resources/agent/vision-prompt.md`（与 Java 同文件），端点在 `app/routers/ai.py`。这个端点**进了契约**（**112 个端点**），两版都受门禁约束。 |
| 4 | **App 链路改了**：端侧 OCR（ML Kit，图片不出手机）→ 云端 `/parse-text` → **确认页**（`EventImportScreen`）→ 逐条 `POST /events`。**点任意一条进整页编辑器**（`EventEditorScreen` 的**草稿模式**：`initialDraft` + `onDraftSaved`，字段与编辑日程完全一致——标题 / 日期 / 时间 / 地点 / 详细地址 / 备注 / 重复 / 提醒，保存只回传给确认页、**不落库**）；确认页上也能就地改日期、删除。没日期的条目标红「请选择日期」，全都有日期后底部「添加 N 条日程」才可点；全部成功回日历刷新，部分失败列出失败项留在页面重试。 |
| 5 | **端侧小模型整个拿掉**：删 `llama.rn` 依赖、`assets/models/*.gguf`、`vision/llamaTextModel.ts`、`metro.config.js`；`vision/onDevice.ts` 现在只留 OCR 接口 + 注册，`vision/register.ts` 只注册 OCR。APK 从 ~570MB 回到 ~100MB。要回退见第十三轮末尾那段。 |
| 6 | **合规同步**：隐私政策 §2.7 改为「图片只在手机本地处理，但 OCR 出的**文字**会上传至我们的服务端解析」；《与第三方共享个人信息清单》补第 5 条（OCR 文字 → 阿里云百炼）；《已收集个人信息清单》补第 21 条；App 相机权限说明也照实改了。`check_compliance.py`（20 项 + `--strict`）全过。 |
| 7 | **耗时埋点**：App 侧 `[vision] 耗时：端侧 OCR xxxms → 云端解析 xxxms`（Metro 日志），服务端 `AgentTextParseService` 打 `识别解析：模型 xxx ms`。真机实测（292 字通知，3 次）：**端侧 OCR 1.5–1.7s、云端解析 1.2–1.8s（其中模型 1.1–1.7s）、合计 2.8–3.4s**。 |

**已知边界（这一轮没验的）**：**没有打真实百炼上游**（两版测试注入的都是假模型），所以
「模型拿到这份提示词到底抽得准不准」只有提示词不变量测试兜底，**上线前建议真图 + 真模型跑一遍**
（那张学院通知图：应出现「离返校登记 · 9/24」、不出现「中秋假期」、允许「返校情况统计」无日期）。
模拟器端到端也没在本机跑（环境起不来）。

---

## 0.0 本次交接摘要（2026-09-30，第十三轮：组织日历收口 + 助手两端对齐）

这一轮把「欠账清单」上剩下的三条**代码层面能做的**一次做完（产品没定的与依赖真机的都没动）。

| # | 内容 |
| --- | --- |
| 1 | **`GET /org-admin/events` 条目新增 `canEdit`**（两版后端，规则与成员侧 `/org/events` 完全一致：只有**发起人本人**为 true，组织管理员也不行）。web-admin 据此显示「撤回 / 删除」，非发起人那行显示「仅发起人可操作」——以前是点下去必收 `20003`、页面只弹个错 |
| 2 | **`GET /org-admin/events` 新增 `includeRevoked`（默认 false）**，条目新增 `status`（`ACTIVE`/`REVOKED`）。web-admin 组织日历加「含已撤回」开关 + 「状态」列，撤回后终于能翻到「这条当初发给谁了」。**删除过的日程两种情形都不列**——那是「取消并删除」，不是「撤回」 |
| 3 | 清掉过期文案：web-admin 撤回确认框与 App 组织日程编辑页还写着「已有成员回执时无法撤回」——回执在第三轮已整条下线，这句话在教用户一个不存在的规则 |
| 4 | **`AgentTranscribeController` 按助手其余部分的结构整理**：新增 `AgentTranscribeService`（大小上限 / 未配置怎么答 / 音频怎么交给模型都在这里），控制器只留 HTTP 胶水；顺手删掉 `AgentChatService.transcriptionEnabled()`（没人用的死方法），补了「超限与忘带文件当场拒掉、不打上游」的用例 |
| 5 | **授权等待不再占线程**（第十二轮记的那条欠账）。`AgentApprovalRegistry.await`（`future.get(200ms)` 轮询 + 阻塞整条流）换成 `register → CompletableFuture`：线程在授权点**交回**，答复 / 超时 / 客户端断开才把循环叫醒继续跑。超时改成 `completeOnTimeout`（值是拒绝，不抛异常），断开改成 `Stream.markClosed() → approvals.cancel(id)`；同一会话的任务在 `Session.stateLock` 上串行，收尾日志只打一次 |
| 6 | **Python 版助手补齐**（第七轮以来的欠账）：`/ai/agent/chat`（SSE）、`/ai/agent/approvals`、`/ai/transcribe` 三个端点 + `agent_tools/agent_scope/agent_write/agent_chat/agent_model/agent_approvals/agent_prompt` 七个服务，语义与 Java 一字对齐。**这三个端点现在进 `contract/api-contract.json` 了**（111 个端点），两版都受契约门禁约束 |
| 7 | **超管建组织可选预置首位拥有者**：创建请求体加 `ownerMemberKey` / `ownerRealName`（两版后端都实现），填了就同时建「总部」根部门 + 一条 OWNER 成员，组织一建好就能在 App 里认领；不填维持老行为。web-admin 新建组织表单加了这两个选填项 |

### Python 助手的几个实现要点（对齐时最容易走偏的地方）

- **等待用 `asyncio.Future`，不是线程**：`agent_approvals` 记住 `(account_id, future)`，
  `await` 它只挂起协程。客户端的断线由「异步生成器被关掉 → 取消 task → 取消挂着的授权」承接，
  所以断开同样是**立刻**按拒绝收尾，不用等满 90 秒。
- **`asyncio.to_thread` 包住所有阻塞调用**（模型是 `urllib` 同步读 SSE、工具是同步 SQLAlchemy），
  delta 通过 `loop.call_soon_threadsafe` 推回队列——事件循环不被上游读取按住。
- **提示词只有一份内容、两处存放**：`backend-python/app/resources/agent/prompt.md` 与
  `backend-java/.../resources/agent/prompt.md` 必须**逐字节相同**，
  `tests/test_agent.py::test_agent_prompt_is_the_same_file_as_java` 钉住了这一点。
  **改提示词要同时改两份 + 两边的 VERSION。**
- 事件名与字段与 Java 一致（`status`/`delta`/`tool`/`action`/`done`/`error`），
  `tool` 带 `toolCallId/name/arguments/result/readOnly/summary/detail`，历史里 tool_use 与 tool_result 必须配对
  （`_repair_pairs`）。

**验证**：Java **149**（新增授权表 6 项 + 语音校验 1 项 + 管理端列表 1 项 + 预置拥有者 1 项）、
Python **70**（新增 `tests/test_agent.py` 10 项 + 预置拥有者 1 项，契约覆盖率仍 100%）、
web-admin **21** + 类型检查与构建、App **206** + typecheck、合规门禁 20 项，全绿。
契约 **111 个端点**（原 108）；spec §6.2 / §11 里「Java 先行、Python 对齐是欠账」的说法已改掉。

> ⚠️ 验证边界：**没有打真实百炼上游**（两版测试注入的都是假模型），也没跑真机 ——
> Python 那版助手在真环境里还没跑过一次。下一轮如果要继续，剩下的是：
> release 包的明网 HTTP 验证、P95 性能验收、App 组件渲染测试（都是明确推迟的项）。

### 追加（同日）：日历页的「上传图片 → 识别日程」入口按**端侧**重做

产品改口径：**识别全程在手机本地**（不给服务端、也不用第三方云），两段式
——端侧 OCR（图片→文字）＋端侧轻量文本模型（文字→结构化草稿）。

已经落地的（**不依赖原生构建的那一半**，App 侧 211 项测试 + 合规门禁全绿）：

- `domain/vision.ts`：抽取提示词 + 模型输出的**容错解析**（抠 JSON、时间归一化、
  编出来的时间一律不认），纯逻辑、有 5 项单测；
- `vision/onDevice.ts`：**注册制**接口（`OcrEngine` + `TextModelEngine` +
  `registerOnDeviceEngines`）。Expo Go 下没有引擎，调用方**如实说明「需要开发版构建」**，
  **不偷偷回落服务端**——「图片不出手机」就是这个功能的承诺；
- `AgendaScreen`：按钮 → 「相册上传 / 拍照上传」（Android 用 Alert 当 ActionSheet）→
  选图 → 端侧链路 → 结果先列出给用户核对（「一键添加」还没接）；
- **拍照回到合规文本里**：`PermissionKind` 加 `camera`、`app.json` 的
  `cameraPermission` 从 `false` 改回文案、隐私政策 §2.7/§9.2 与「不会申请相机」那句同步改，
  `check_compliance.py` 的权限四类断言跟着改（20 项 + `--strict` 都过）。

**已经不是 Expo Go 了——改成出真 APK**（2026-09-30 晚）。工具链与出包方法：

- WSL 里的 Linux Android SDK：`/home/jiang/tools/android-sdk`（build-tools 36 / platform 36 /
  **NDK 27.1.12297006 / CMake 3.22.1**，NDK 与 CMake 是构建时自动装的）、JDK 17
  （`/home/jiang/tools/jdk-17`，Android 工具链要 17，本机只有 21）、系统 Gradle 9.3.1
  （`/home/jiang/tools/gradle-9.3.1`，**别用 `./gradlew`**：`expo prebuild` 会把 wrapper
  的 distributionUrl 改回不通的官方源，且会丢掉自定义镜像）
- 国内镜像：`~/.gradle/init.gradle`（用户级，prebuild 重生成工程也不会丢）统一加阿里云；
  Gradle 发行包走腾讯镜像 `mirrors.cloud.tencent.com/gradle/`；JDK 17 走清华 Adoptium
- 出包：`npx expo prebuild --platform android --clean` → 在 `app/android` 里跑
  `gradle :app:assembleDebug`（`ANDROID_HOME=/home/jiang/tools/android-sdk`）。
  **必须把 ABI 砍成 x86_64**（`app/android/gradle.properties` 的 `reactNativeArchitectures`）：
  4 个 ABI 时编了 28 分钟还卡在原生库合并，砍成一个后 **1 分半**出包
- 装：`adb.exe install -r app/android/app/build/outputs/apk/debug/app-debug.apk`
  （debug 包要 Metro：`npm run dev:app` + `adb reverse tcp:8081 tcp:8081`）
- **adb.exe 是 Windows 程序，读不了 WSL 路径**：`adb push` 要用 `wslpath -w <路径>` 转一次

**已经跑通的**：端侧 **OCR** = `@react-native-ml-kit/text-recognition`（中文脚本），
`src/vision/mlkitOcr.ts` 实现 + `src/vision/register.ts` 动态注册（Expo Go 下不加载、保持未注册）。
在真图上验证过：串起「按钮 → 弹层 → 相册/拍照 → 选图 → 端侧 OCR → 文字」，
识别质量与桌面 RapidOCR 接近（「提醒」误成「提程」、「一、」误成「-」，其余一致）。

**「端侧小模型」这条路已放弃，改成服务端解析**（2026-10-01）：0.5B（`llama.rn` + GGUF）
在「一份通知抽多条」上不够用（真机对比），而且把 APK 撑到 ~570MB。现在链路是
**端侧 OCR → `POST /ai/events/parse-text`（百炼，结构化输出）→ 确认页**；
`llama.rn` 依赖、`assets/models/*.gguf`、`vision/llamaTextModel.ts`、`metro.config.js`
都已删除（包体回到 ~100MB），`vision/register.ts` 现在只注册 OCR。
**要回退**：把 `llama.rn` 与 `.gguf` 加回、恢复 `metro.config.js` 的 `gguf` assetExts，
并在 `register.ts` 里把文本模型实现也注册上——旧实现可从 git 历史里翻。
解析口径写在 `agent/vision-prompt.md`（Java / Python **两份逐字节相同**，有测试守着）：
只抽「要你做的事」、日期有就写没有就留空、不猜时刻。

---

## 0.0 本次交接摘要（2026-09-30，第十二轮：助手整体对齐 mewcode）

用户给的参考实现是 `C:\Users\jiang\Downloads\mewcode-java.zip`（一个 Java 版 Codex，
解压在 `/tmp/mewcode`）。**「整个助手就参考 mewcode」**——这一轮就是把小安按它的骨架重做。

### mewcode 的四条骨架 → 我们落地成什么

| mewcode | 我们 |
| --- | --- |
| `agent/Agent` 一次对话一个循环，工具调用逐个执行、结果写回再问模型 | `AgentChatService.run()` 重写成同样的循环（不再「遇写即停、下一轮再续」） |
| `permission/PermissionChecker` + `PermissionRequestEvent` + `future.get(5min)`：**写操作在循环里阻塞等用户答复** | 新增 `permission/AgentApprovalRegistry`：写工具发 `action` 事件后阻塞等待；客户端用 **`POST /ai/agent/approvals`**（新端点，`{actionId, allow, feedback}`）答复 |
| `StreamingExecutor.executeSingle`：权限通过后**由 agent 自己执行工具**，结果作为 tool_result 回灌 | 新增 `permission/AgentWriteExecutor`：允许后用 `EventService` 真正落库（与 REST 同一套 Service，隔离沙盒/校验一个不少）；拒绝 → 回灌「用户拒绝了、什么都没改」 |
| `conversation/Message` + `ToolPairing.ensure`：历史里 assistant.tool_calls 与 tool 结果**必须配对** | 客户端 `toTurns()` 按配对形状回放（`tool` 事件带 `arguments` 与 `result`）；服务端 `buildConversation` 再修一遍（缺结果补 `interrupted`、孤儿结果丢掉） |

### 协议变化（App ↔ 服务端）

- `POST /ai/agent/chat`：`{messages:[{role,content,toolCalls?},{role:'tool',toolCallId,content}] ,orgIdentityId}`
  —— **没有 `actionResults` / `pendingActions` 了**，也**不再由 App 调 REST 写库**。
- SSE 事件：`status` / `delta` / `tool`（新增 `arguments` 与 `result`，客户端回放历史要用）/
  `action`（授权请求，**流保持打开**）/ `done` / `error`。
- 新增 `POST /ai/agent/approvals`：用户在面板上点允许/拒绝时调用；服务端收到后同一条流继续跑。
- 授权等待上限 **90 秒**（`AgentApprovalRegistry.await`），且**客户端断开就立刻按拒绝收尾**
  （之前 4.5 分钟上限 + 不感知断开，实测会卡住好几分钟）。

### 这一轮修掉的两个真 bug（都来自上一版的「App 写库 + 下一轮回传结果」设计）

1. **点「拒绝」毫无反应**：动作 id 原来每轮都从 `a1` 重新开始，客户端按 id 全局找卡片，
   命中的是**上一轮那张已处理的**卡片（状态不是 pending）→ 直接 return。
   修法：服务端 `newActionId()` 用纳秒做全局唯一 id；客户端 `cardInMessage()` 按消息定位。
2. **授权面板永远不出现（看起来像卡死）**：面板渲染条件写的是 `pendingAuth && !streaming`，
   而新流程里服务端**正在**流未结束时阻塞等授权 → 条件永远为假。
   修法：有 pending 卡片就顶掉输入框，不管 streaming。

### 为什么值得这么改

上一版把写操作交给 App 用 REST 执行、结果下一轮再回传，副作用是：历史里丢了工具调用、
授权卡片会重复出现、动作 id 会撞车、拒绝可能点不动——**都是这一处设计的连带问题**。
改成 mewcode 那样「工具在循环里执行、权限阻塞等待、结果写回同一个历史」之后，
这些问题从结构上就不存在了。

### 验证

- Java **140** 项全绿（含重写的写操作用例：允许→落库+工具结果、拒绝→不落库+「什么都没改」、
  一轮内多个调用按顺序执行、客户端工具配对回放与补齐、授权 id 跨轮唯一）。
- App **206** 项 + typecheck 全绿；web-admin 18、Python 58、合规门禁 20 项全绿。
- 线上（8.136.20.182）**原始客户端端到端**：允许 → `tool` 结果 + 模型收尾 + 库里出现日程；
  拒绝 → 同一条流继续 + 库里一条不写（`1 → 1`）。
- 模拟器：允许路径走通（工具行「已创建日程」+ 助手「已将…开上」+ 输入框回来）。
  **拒绝路径的界面点按没来得及复验**（模拟器中途掉了），但两条路径在客户端是同一个函数。

### 仍然欠的

- `AgentTranscribeController` 与助手其余部分还没按 mewcode 的 `ToolRegistry` / `PromptBuilder` 结构整理。
- 授权等待占着一个虚拟线程（`agentStreamExecutor`）；并发一上来要换成异步等待。
- Python 版仍然没有助手（Java 先行，见 §0.0 第七轮的欠账）。

> ✅ 以上三条**在第十三轮已收口**（见文件顶部的第十三轮摘要）：
> 语音那一路已抽成 `AgentTranscribeService`；授权等待改成 `CompletableFuture`，等待期间不占线程；
> Python 版助手已补齐，三个端点也进了契约。

### 当前状态与怎么复验这条链路

- **线上**：`http://8.136.20.182:8088` 已跑本轮 jar（`/opt/xatodo/backend/jar.bak-*` 有备份）；
  演示库里日程 / 待办都是 **0 条**（验证留下的数据已按正式删除接口清掉）。
- **复验（不用模拟器，最快）**：
  1. `ssh` 进去 `docker exec xatodo-redis redis-cli set sms:code:18006569106 246810 EX 900`
     （验证码不真发短信）；
  2. `POST /auth/login/sms` 拿 token；
  3. `POST /ai/agent/chat`，body `{"messages":[{"role":"user","content":"明天下午三点和张总开会"}]}`：
     应当 0.0s 收到 `status` + `action`（`actionId` 形如 `ap8xnpg3baa-1`），**然后流保持打开**；
  4. 拿这个 `actionId` 打 `POST /ai/agent/approvals`：`{"allow":true}` → 流继续，收到 `tool`
     （结果 JSON 带 `eventId`）+ `delta`（模型复述结果）+ `done`，库里出现这条日程；
     `{"allow":false}` → 同样继续，但库里**一条都不会写**。
- **模拟器**：`/mnt/c/Users/jiang/AppData/Local/Android/Sdk/emulator/emulator.exe -avd Medium_Phone`
  起 AVD，WSL 里用 `/mnt/c/.../platform-tools/adb.exe`；`adb reverse tcp:8081 tcp:8081` 让 App 连本地 Metro。
  点击一律用 `uiautomator dump` 拿 `bounds` 再换算（画面 1080×2400），目测坐标点不中。


## 0.0 本次交接摘要（2026-09-29，第十一轮：删掉「全天」字段 + 授权后重复申请的真根因）

### 这一轮做完的

| # | 内容 |
| --- | --- |
| 1 | **`all_day` 字段整个删掉**（产品决定）：V19 迁移把 `event.all_day` 与 `task.all_day` 两列真删。约定替代它：**时间点落在当地 00:00 = 「只说了哪一天」**，界面只显示日期、不显示 00:00，也**不再有「全天」这个词**。 |
| 2 | 两版后端 / App / web-admin 全部对齐：编辑页删掉「全天」开关、时间选择层标题统一「时间」；助手 `create_my_event` 不再有 `allDay` 参数；视觉识别输出也不再带 `allDay`。 |
| 3 | **修掉「点了允许、日程建好了，却又冒出一条一模一样的授权行」**（用户在模拟器上发现的）。根因与证据见下一节。 |
| 4 | 线上已部署：V19 生效（`information_schema` 查过，两列都没了）、修复生效；接口级端到端复验 12/12 不再重复申请；模拟器上「建日程 → 允许 → 授权块消失、输入框回来」走通。 |

### 「允许之后又申请一次」的真根因（这条值得从头读一遍）

现象：用户点「允许」，日程确实建好了，但紧接着界面上**又出现一条一模一样的授权行**；
再点一次就会建出第二条日程。

排查路径（照这个顺序做，别跳步）：

1. 先怀疑 App 把「已处理」的卡片又当成「还挂着」发给服务端 → 对照实验**否掉了**：
   带不带 `pendingActions` 都 6/6 复现。（顺手修掉了这个真不一致：`pendingActionsAfterResults`。）
2. 再怀疑「模型看不到自己的工具调用，所以又调一次」→ 按 mewcode 的 `ToolPairing`
   把「助手工具调用 + 配对结果」补回上下文。**仍 9/9 复现**，说明还不是它。
3. 直接用线上密钥对上游做最小复现（`/tmp/xa_upstream.py`）：五种形状**都不重复** →
   触发点在我们自己构造的上下文里。
4. 于是给上游客户端加了一个 dump 开关（容器里 `touch /tmp/agent-dump-on` 即可，见 §调试），
   **把真实发给上游的请求打出来**，一眼就看到末条消息是：

   ```
   [system] 系统提醒：用户这句话是要创建 / 修改 / 删除日程的意思，但你只回了一段文字，
            还没走到申请授权……请立刻真正调用工具
   ```

   —— 是**我们自己的兜底追问**在续跑那一轮误触发：续跑时客户端带回授权结果，
   模型本来就该只回文字，而追问的判据（用户那句话是写意图 + 这一轮没调工具）恰好成立，
   于是它照着「请立刻调用工具」又申请了一次。

**修法**（两处，都在 `AgentChatService`）：

- **带 `actionResults` 的续跑轮不再追问** —— 这是根因修复。追问只该用于「用户提了要写的事、
  模型却只聊了一句」的首轮。
- 仍然按 mewcode 的做法把**工具调用 + 配对结果**回放给模型（`replayActionOutcomes`）：
  每个 `tool_use` 都要有 `tool_result`，这是参考实现 `conversation/ToolPairing` 的核心约定；
  老客户端不带 `payload` 时退化成原来的系统说明。

证据：修复后对照实验 **12/12 都不再重复申请**（带 payload / 不带 payload 都一样）。

### 这一轮踩的最大的坑：**改已经执行过的迁移文件**

我顺手把 V18 的两行注释改得更贴切，结果线上后端**起不来**（容器重启 8 次）：

```
Migration checksum mismatch for migration version 18
```

Flyway 校验和覆盖整个文件（**注释也算**）。已上过线的迁移文件一个字节都不能动。
这次是从线上备份 jar 里把那份 V18 原样取回来对比、逐字节恢复才好的。
**规矩：要改口径就新开一个迁移（V20…），别回去改 V18/V19。**

### 调试助手用的开关

容器内 `docker exec xatodo-backend touch /tmp/agent-dump-on` 之后，
每一次发给上游的请求都会以 `agent upstream request: {...}` 打进 `docker logs`。
排查「模型为什么这么答」这类问题必备（第 4 步就是靠它定位的）。
⚠️ 日志里会含用户日程正文，**排查完立刻 `rm` 掉这个文件**。

### 当前状态

- **测试基线**：Java **141**、Python **58**、App **220** + typecheck、web-admin 18、合规门禁 20 项，全绿。
- **线上**：`http://8.136.20.182:8088` 已跑 V19 + 本轮修复；DB 备份 `/opt/xatodo/db.bak-20260929-*`，
  jar 备份 `/opt/xatodo/backend/jar.bak-*`。
- **模拟器**：Windows 侧 AVD `Medium_Phone`（`/mnt/c/Users/jiang/AppData/Local/Android/Sdk/emulator/emulator.exe -avd Medium_Phone`），
  WSL 里用 `/mnt/c/.../platform-tools/adb.exe`。**点不动就是坐标不对**：用 `uiautomator dump`
  拿 `bounds` 换算设备像素（画面 1080×2400），别照比例目测。

## 0.0 本次交接摘要（2026-09-29，第十轮：单时间点收尾 + 助手授权行的真 bug）

### 这一轮做完的

| # | 内容 |
| --- | --- |
| 1 | **漏改收尾**：`prompt.md` 里残留的 `startAt`/`endAt`、`AgentChatService.renderPendingActions` 读的 `payload.startAt`（会让「挂着的那次授权」丢掉时间）、`AgentVisibleEvents` 的参数名与报错文案、`ConversionService` 的死常量 `DEFAULT_EVENT_MINUTES=60`、`backend-java/README.md`、spec §5.5 表结构 / §5.8 索引 / §6.2 的 `/search` 与 `/ai/events/recognize` 响应 / 组织日程示例，全部对齐单时间点。 |
| 2 | **App 内部命名**：草稿字段 `startTime` → `time`、`DEFAULT_START_TIME` → `DEFAULT_EVENT_TIME`，删掉没人用的 `addMinutes` / `DEFAULT_END_TIME` / `nextDateKey`；编辑页时间选择层的标题从「开始时间 / 结束时间」改成「时间」（这是**用户可见**的残留）。 |
| 3 | **V18 补重建索引**：`DROP COLUMN` 会连带删掉引用它的索引（`idx_event_calendar_range` / `idx_event_org_range`），迁移里补上 `idx_event_calendar_at(calendar_id, at)` 与 `idx_event_org_at(org_id, at)`。 |
| 4 | **修掉「删除 / 修改不出授权行」的真 bug**（线上实测抓到）：用户说「把明天和张总的那个会删掉」，模型先 `list_my_events` 查到，然后只回一句「…删掉，确认一下？」就收尾了 —— 界面上没有可点的授权行。详见下节。 |
| 5 | **线上部署 + 接口级端到端复验**：V18 在 prod 执行成功，`event` 表只剩 `at`（`information_schema` 查过），`aiAgentEnabled=true`；完整走通「只给一个时间点建日程 → 小安只申请 `at`（不再猜结束时间）→ 允许后自动继续且不重复申请 → 删除出授权行 → App 侧 REST 删除」。 |

### 兜底追问改成了两档（这一轮的核心修复）

`AgentChatService` 里那条「模型只回文字、不调工具」的兜底追问，现在这样判：

- **一个工具都没调** → 宽口径 `looksLikeWriteIntent`（写动词 **或** 时间词 + 事件味），
  「明天下午三点和张总开会」这种一个动词都没有的说法也要接住；
- **已经查过、但没走到申请授权** → 窄口径 `hasWriteVerb`（**只认写动词**）。
  不能对这种情形用宽口径：「我明天有什么安排」会被推成写操作，凭空申请一次授权。
- `writeAttempts > 0` 时**不再追问**：模型已经试过写、只是失败了（找不到那条日程），
  再追问只会让它重试同一个必然失败的动作。

提示词同步去掉了「说『要把时间改到 17:00，确认一下』这种」这个反面教材 ——
它其实在教模型「说完这句话就停」，正是这个 bug 的源头之一；现在改成
「这句话必须跟授权请求一起出现，不能拿文字代替授权」。

### 这一轮踩到的三个坑

1. **测试手机号不能复用**：两个用例用了同一个号 → 60 秒内二次发码被频控拦掉（20005），
   而报错会出现在几步之后的登录上（「验证码不能为空」），看起来像业务坏了。
   现在 `AgentModuleTest.registerAccount` 有一道 `USED_PHONES` 闸，复用会立刻失败并说明原因；
   `postJson` 也会在业务码非 0 时打印响应体。
2. **按 IP 的验证码日限额在测试里必须放宽，但父 pom 配不生效**：整套用例都从「127.0.0.1」发码。
   正确位置是 `xa-bootstrap/pom.xml` 里 surefire 自己的 `systemPropertyVariables`
   （已经是 100000）；写到**父 pom 的 pluginManagement 里会被整块覆盖掉**，看着配了其实没用。
3. **范围查询返回的字段名是 `eventId` 不是 `id`**：Java 侧配了 `non_null`，空字段直接消失，
   拿 `id` 去取就是 `undefined`。写脚本 / 客户端时按 DTO 里的字段名来。

### 当前状态

- **测试基线**：Java **139**、Python **58**、App **219** + typecheck、web-admin 18、合规门禁 20 项，全绿。
- **线上**：`http://8.136.20.182:8088` 已是单时间点版本（V18 已应用、`aiAgentEnabled=true`）。
  jar 备份在 `/opt/xatodo/backend/jar.bak-*`，DB 备份 `/opt/xatodo/db.bak-20260928-223156.sql.gz`。
- **仍未验证的**：App 真机 / 模拟器走一遍 —— 本机没有 AVD 与 Android SDK，模拟器起不来，
  所以「授权块顶替输入框」「长按说话」这些**纯界面**部分这一轮没有真机证据。

### 复验脚本

`/tmp/xa_e2e.py`：`python3 xa_e2e.py` 跑全流程、`python3 xa_e2e.py cleanup` 只清数据。
它不真发短信 —— 直接往演示机 Redis 写 `sms:code:<手机号>`；跑完会删掉自己造的日程
（只按标题 `E2E 单时间点` / `和张总开会` 删，别拿它去清真实数据）。

## 0.0 本次交接摘要（2026-09-28，第九轮：日程与待办都只有一个时间）

### 为什么改

助手要建日程时，用户只说「明天下午三点和张总开会」——**结束时间是我们猜的**（先按 +1 小时补，
后来加了硬闸拦「模型自己补 1 小时」）。产品结论：**不要猜，也不要有"结束时间"这个概念**：
日程与待办一样，都只有一个时间点。

### 这一轮做完的

| # | 内容 |
| --- | --- |
| 1 | **DB**：V18 迁移把 `event.start_at` + `event.end_at` 合并为 `event.at`（存量数据取原 start_at），`event_exception.override_start_at/override_end_at` → `override_at`。**不是遗留列，真的删掉了**。 |
| 2 | **Java**：实体 / DTO / `EventService` / `RecurrenceExpander` / 组织日程 / 搜索 / 提醒 / 助手工具 / 视觉识别全部改单时间；`selectInRange` 与 `searchEvents` 的 SQL 同步（窗口判断变成「这个点落不落在窗口里」）。 |
| 3 | **Python 版同步对齐**（用户明确要求）：同样的 SQL、同样的单时间展开、同样的校验。 |
| 4 | **App**：编辑页只剩一行「时间」；列表/检索/待办转日程都只显示一个时刻；`formatTimeRange` → `formatEventTime`。 |
| 5 | **web-admin**：组织日程表单从「起止时间」改成单个时间选择器。 |
| 6 | **助手**：`create_my_event` 只要求 `title` + `at`；`list_my_events` 的时间窗口参数改名 `from`/`to`（避免与"日程只有一个时间"混淆）；「不许自己按 1 小时补」的硬闸与相关提示词整段删除——**没有结束时间，就无从猜起**。 |
| 7 | spec §3/§4.1.x/§5.x 与 docs/legal 的「起止时间」表述全部改成「时间」。 |

### 交接必读

1. **`at` 是唯一时间字段**：`event.at`、`event_exception.override_at`、API 的 `at`、助手动作 payload 的 `at`。
   看到任何 `endAt` / `end_at` / `时长` 的残留都是漏改，报 500 或字段缺失。
2. **只说了哪一天 = 当天 00:00**（`all_day` 已在 V19 删掉）；**不再支持跨天**（产品明确接受这个损失）。
3. `list_my_events` 的 `from`/`to` 是**查询窗口**，不是日程字段——别让模型把它当成日程的开始/结束。

---

## 0.0 交接摘要（2026-09-28，第八轮：工具重构 + 逐条授权）

### 这一轮做完的（关键项都在真机 / 线上验过）

| # | 内容 |
| --- | --- |
| 1 | **工具集收窄成五个，且只碰个人日程**：`list_my_events`（时间必填 / 正序 / 超 20 条只回"太多了"让模型缩小范围）、`read_my_event_note`（备注分段读，offset+length，单次封顶 500 字）、`create_my_event` / `update_my_event` / `delete_my_event`。删掉了 `find_free_slots`（空闲改由模型自己看日程推算，提示词给了 09:00–21:00 的口径）。 |
| 2 | **隔离沙盒**：四个入口全部收敛到「账号 → 个人身份 → 自己的日历」；他人的 eventId 一律当"找不到"（不泄露存在性），组织日程不在范围内。有专门用例钉住。 |
| 3 | **执行语义**：一轮里按声明顺序推进——连续查询**并行**、遇写**即停**（发出授权请求后本轮结束，后面的调用不执行）；写失败则把错误回灌给模型继续下一轮。⚠️ 第十二轮已改：现在一轮里所有调用按顺序执行，写在权限层**阻塞等答复**后由服务端执行。 |
| 4 | **Codex 式逐条授权**：App 在对话下方**一次只摆一条**「允许 / 拒绝」；允许 → 调既有 REST → **自动继续**（上限 3 次）；拒绝 → 停下等用户说话；未处理就发新消息 → 记为「未处理」一并回传。⚠️ 第十二轮已改：App 不再调 REST、也没有自动继续；点允许/拒绝只是 `POST /ai/agent/approvals`，服务端在同一条流里继续。 |
| 5 | **工具调用可见**：新增 SSE `tool` 事件，查询类给「已查日程 · N 条」+ 人话明细，写入类给「已申请创建 / 修改 / 删除」；界面一行小字、可展开。 |
| 6 | **提示词工程化**：正文搬到 `xa-agent/src/main/resources/agent/prompt.md`（占位符替换），`PROMPT_VERSION` 随用量进日志，并加了提示词回归测试（关键不变量在、开发语气词不在）。 |
| 7 | 顺手修掉两个真 bug：① 写失败时不把错误回灌（模型永远看不到那句错误）② MockMvc 连发多条 SSE 时异步派发抢写同一个响应（见 §5）。 |

### 交接必读的三条

1. **工具名带 `my_` 前缀是边界声明，不是风格**。组织日程下一阶段以**新工具**加入
   （`list_org_events` 之类），**不要**把这五个改造成"既能个人又能组织"。
2. **授权是「一次工具调用 = 一次授权」，且遇写即停**：所以模型一轮里最多只请求一条写操作，
   App 侧的授权队列几乎总是长度 1；这个不变量由服务端保证，别在客户端"攒批"。
3. **改提示词必须同时改 `AgentPrompt.VERSION`**，否则线上出问题时分不清跑的是哪一版。

---

## 0.0 交接摘要（2026-09-27，第七轮：小安接入通义千问）

### 这一轮做完的

把「小安」从**只有入口的骨架**变成真能用的助手：流式回答、能查可见日程、能建 / 删**个人**日程
（写操作**必须用户确认**）、支持**语音输入**；交互按豆包那套路子（骨架，视觉仍是现有黑白令牌）。

| # | 内容 | 位置 |
| --- | --- | --- |
| 1 | 新模块 `xa-agent`：模型配置、流式客户端、工具注册表、可见日程、空闲时段、SSE 编排 | `backend-java/xa-agent/**` |
| 2 | `POST /ai/agent/chat`（SSE：`status` / `delta` / `action` / `done` / `error`）与 `POST /ai/transcribe` | `AgentChatController` / `AgentTranscribeController` |
| 3 | 4 个工具：`list_events`（个人 + 当前组织，只读）、`find_free_slots`、`create_event`、`delete_event` | `AgentToolRegistry` |
| 4 | **确认回路**：写操作只生成卡片 → 用户在卡片上确认 → App 调既有 REST → `actionResults` 回到下一轮 | `domain/agentActions.ts` + `AgentChatService` |
| 5 | App 重写对话页：空态推荐问法、用户右侧气泡、助手左对齐正文、生成光标 + 停止、清空对话、长按复制、轻震动 | `screens/AgentChatScreen.tsx` |
| 6 | 语音：长按说话（计时 + 音量条 + 上滑取消）→ 转写 → 文本入框（不自动发送） | `screens/agentMic*.tsx`、`domain/permissions.ts` |
| 7 | 轻量 Markdown 子集（粗体 / 行内代码 / 列表 / 引用）自研 + 单测 | `domain/agentMarkdown.ts`、`components/AgentMarkdown.tsx` |
| 8 | 能力判定改成读服务端：`GET /system/info` 新增 `aiAgentEnabled` | `SystemController` + `domain/agent.ts` |
| 9 | 合规同步：隐私政策 §2 / §4.1 / §6.2 / §9.1 / §9.2、两份清单、`check_compliance.py` 新增 `assistant-disclosure`（19 → **20** 项） | `docs/legal/**`、`scripts/check_compliance.py` |
| 10 | 部署：nginx 给 `/api/v1/ai/` 单独 `location`（**关缓冲**，否则流式变一次性）+ compose/`.env.example` 透传变量名 | `deploy/**` |

### 两个必须记住的规矩

1. **新规矩：默认 Java 先行，未经明确要求不做 Python 对齐。** 因此
   `/ai/agent/chat` 与 `/ai/transcribe` **刻意不写进 `contract/api-contract.json`**
   （那份清单的语义是「两版都必须实现」），口径写在 `spec.md` §6.2 的
   「智能助手『小安』（阶段三 · Java 先行）」。**欠账：Python 版对齐。**
   > ⚠️ **2026-09-30 第十三轮已收口**：Python 版助手补齐，这四个端点已进契约（111 个端点）。
   > 「Java 先行」仍是**做事的默认顺序**（先做一版、跑通再对齐），但不再是"另一版不做"的借口。
2. **模型没有写权限**。它只能生成待确认卡片；真正的写入永远发生在**用户点确认之后**。
   > ⚠️ **2026-09-30 第十二轮已改**：执行方从「App 调 REST」改成「服务端在权限通过后调同一套
   > Service」（见文件顶部第十二轮摘要）。后半句不再准，但**「用户不确认就不写库」这条底线没变**——
   > 改链路前先想清楚这一点。

### 交互上容易被误解的一点（本轮被打回过一次）

**确认卡片必须在对话区里摊开写清「将写入的日程」**（标题 / 日期 / 时间 / 地点），
而不是一句「创建日程」——用户要能一眼核对，**并且可以继续提要求修改**，
不满意就接着说「改成下午四点」。删除同理：卡片要把**将被删掉的那条日程**摊开，
否则用户没法判断助手是不是找对了那条（删错了找不回来）。

**卡片只在模型调用 `create_event` / `delete_event` 这两个写工具时出现。** 查询类工具
（`list_events` / `find_free_slots`）在服务端直接执行、结果回灌给模型，界面只有一行
「正在查日程…」的状态提示，然后模型用文字回答——**查一次就弹一张卡片让用户点确认，那是错的方向**。
反过来，写工具缺信息（没给时间）或被拒（组织日程 / 日程不属于本人）时也**不出卡片**，
只回一句工具错误，由模型去说明或追问（`AgentModuleTest.queryToolsNeverProduceConfirmationCards` 盯着这条）。

为让「继续修改」成立，客户端会把**还没确认的卡片**作为 `pendingActions` 带进下一轮请求
（`AgentChatService.renderPendingActions` 拼进系统提示）——卡片正文不在对话历史里，
不带的话模型根本不知道「它」指什么。同一类动作在对话区**只留最新一张**（`mergeActionCards`）。

### 配置与选型

- 默认 `qwen3.6-flash`（阿里云百炼 OpenAI 兼容模式）：实测「中文 + 工具 + 流式」形状下
  首字最快、总耗时最短，且 flash 档比 plus 便宜。`XATODO_AGENT_MODEL=qwen3.7-plus`
  一行即可切换。关思考（`enable_thinking=false`）、`max_tokens=600`、
  只送最近 10 轮、工具结果紧凑 JSON、`stream_options.include_usage=true` 记用量。
- **`XATODO_AGENT_API_KEY` 留空 = 未接入**：对话接口直接返回 `90002`，
  `/system/info` 的 `aiAgentEnabled=false`，App 保持「还没有接入模型」的老文案。
  真 Key 只放本地 `.env.local` 与服务器 `/opt/xatodo/.env`，仓库里搜不到明文。
- ⚠️ **还没在真机 / 线上验证过的部分**：真实百炼上游的流式与语音转写（本地测试注入的是**假上游**），
  以及 nginx 关缓冲后的逐块到达。上线后要按 §9.0 部署，再用带 token 的 `curl -N` 打一次 SSE 确认。
- ⚠️ **`expo-audio` 要 Expo Go / dev build 支持**；缺模块时 App 的麦克风按钮会明确提示不可用，
  不会让整个 App 起不来（`screens/agentMic.tsx` 用的是动态 import）。

### 当前状态与测试基线

- **Java 126**（助手模块 17 个用例：工具循环 / 事件序列 / 上游帧解析 / 空闲时段边界）、
  **App 204 + typecheck**（原 170）、
  **web-admin 18**、**合规门禁 20 项**（原 19），全绿。
- 契约仍是 **108 端点**（本轮**不动** `contract/api-contract.json`）。
- 新增 App 依赖：`expo-audio ~57.0.5`、`expo-clipboard ~57.0.2`、`expo-haptics ~57.0.3`；
  `app.json` 增加 `expo-audio` 插件（麦克风用途说明，且关掉后台录音 / 后台播放）。

### 下一步

1. **真机走一遍小安**（模拟器 + Expo Go）：①说「明天下午三点开一小时会，标题张总会」→
   卡片摊开 → 确认后日历里出现；②说「改成四点」→ 卡片被替换（不是多出一张）；
   ③问「我下周三有什么」含当前组织日程；④删除个人日程；⑤长按说话 → 文本入框 → 发送；
   ⑥把 `XATODO_AGENT_API_KEY` 清空后仍显示「未接入」。
2. 线上：按 §9.0 上 jar + `nginx -t && nginx -s reload`；`curl -N` 确认逐块到达、
   `/system/info` 的 `aiAgentEnabled=true`、`docker logs` 看 token 用量。
3. 欠账：Python 版对齐（含契约补 2 个端点）；`pendingActions` 的契约化。

---

## 0.0 交接摘要（2026-09-27，第六轮：提醒链路闭环）

**先看这两份**：[`docs/plan-2026-09-27.md`](docs/plan-2026-09-27.md)（执行清单）、
[`docs/review-2026-09-27.md`](docs/review-2026-09-27.md)（review 结论）。

### 这一轮做完的

| # | 内容 | 提交 |
| --- | --- | --- |
| 1 | 日程编辑页接「重复」「提醒」两条二级页；提醒写 `PUT /reminders` + `expo-notifications` 本地排期 | `e8c37d2` |
| 2 | 通知权限也走「先说明用途」（`askPermission('notification')`）+ 隐私政策权限清单同步 | `72a4098` |
| 3 | **契约新增 `GET /reminders/schedule`（106 → 107 端点）**：未来 30 天所有会响的提醒，**重复日程按每次实例展开**（展开留在服务端，客户端不自己实现 RRULE） | `8083564` |
| 4 | App：冷启动 / 回到前台 / 每次保存删除后**对齐本机排期**（服务端没返回的目标一律撤销）；「我的 → 到点提醒」总开关；**通知点击统一路由**（含冷启动补捞） | `8083564` |
| 5 | **待办也支持重复与提醒**：两版后端补 `rrule` 的读/写与校验（PATCH 里空串 = 清空），编辑页加「重复 / 提醒」两行（有截止时间才出现） | `8083564` |
| 6 | 模拟器真跑暴露的两处修复（`PUT /reminders` 字段名 `items`、Expo Go 下的通知降级）；合规联系方式填入并部署（`--strict` 通过） | `556257f` |
| 7 | **关联日程候选改成「全部日程 + 可搜索」**：契约新增 `GET /events/all`（107 → 108 端点），App 关联页加搜索框 | `77e0fbe` |
| 8 | 日程编辑页删掉没有任何消费方的六行（链接 / 分类 / 出行 / 优先级 / 闲忙 / 状态）；修掉「出行」显示成 `undefined` 并连带堵住保存的 bug | `684b757` |
| 9 | 「我的」页精简：删掉「身份 #id / 账号 #id」（内部标识）、**「接口地址」**（`__DEV__` 在 Expo Go 里恒为 true，等于没藏住）、两处复述标题的副标题 | `02a0e75` |

> 「接口地址」不只在正式包里该藏，**Expo Go / dev client 里 `__DEV__` 也是 true** ——
> 演示包照样把 `http://<ip>:8080` 摆在用户眼前。要彻底不露，就只能从界面拿掉（现在是这么做的），
> 开发需要地址时读 `app.json` / `.env.local`。

### 「后端不输出空字段」这个坑（2026-09-27 再次踩到）

Java 侧配了 `default-property-inclusion: non_null`：**值为空时字段整个消失**，客户端拿到的是
`undefined` 而不是 `null`。`draftFromEvent` 里写成 `event.travelTimeMinutes === null ? '' : String(...)`，
于是缺失时得到字符串 `"undefined"`：编辑页那一栏显示成 `undefined`，而且 `parseTravelTime` 判它非法
—— **用户改一个字都存不进去**。同处 `event.locationName === null && event.latitude === null`
会给没有地点的日程造出一个叫「已选地点」的假地点。

**规矩：解析服务端响应里的可空字段一律用 `== null`（同时覆盖 null / undefined），不要用 `=== null`。**
`app/test/eventDraft.test.ts` 有一组「字段可能整个缺失」的回归用例盯着。

顺带删掉日程编辑页那六行：链接/分类没有任何读取方（分类筛选还没做）、出行时间要等「出发提醒」、
闲忙要等合并视图、状态要等参与者与邀请（阶段二）、日程优先级全仓无人读。
**字段与接口全部保留**（draft 照旧读写），将来做对应功能时接回界面即可。

### 「关联日程」这一处踩过的坑（2026-09-27）

- 原实现把候选限制成「此刻起 120 天」，**spec §4.1.6 从来没有这条限制** ——
  结果用户早上建的日程晚上就关联不上，界面还显示「近期没有可关联的日程」（明明刚建过）。
  现在候选 = 我的**全部日程**（`GET /events/all`，按开始时间倒序，每个重复序列只出现一次
  —— `task.event_id` 指向的正是序列本身），并且支持关键字检索（标题 / 描述 / 地点，
  与检索共用一份 `ESCAPE` 转义规则：`LikeQuery` / `search.like_pattern`）。
- 前一轮我还按「今天 00:00 起」改过一次（治了「今天早些时候的日程」），但那仍是**自己发明的窗口**；
  产品口径是「待办和日程是对等的，任何一条日程都能挂待办」。**别再给候选加时间窗**。
- 端点路径要注意 `/events/all` 必须声明在 `/events/{id}` **之前**（FastAPI 按声明顺序匹配）。

### 模拟器真跑一遍才发现的两个坑（2026-09-27 当天）

1. **`PUT /reminders` 的数组字段名是 `items`，不是 `reminders`。** 客户端一度按语义写成
   `reminders`，而两版后端 DTO 都要 `items` —— 两版后端的测试都只测 `items`，App 又是
   第一个真正调用这个接口的地方，于是「保存提醒」必然 10001「items 不能为空」，
   直到第一次在模拟器里点保存才暴露（界面上的表现是「待办已保存，但提醒没有存上：…」）。
   修法：请求体形状下沉到 `domain/reminderSchedule.ts` 的 `buildSetRemindersPayload` + 单测，
   spec §6.2 也补上了字段名。
2. **Expo Go（Android）用不了 `expo-notifications`。** SDK 53 起该模块的推送部分被移出 Expo Go，
   只要 `import('expo-notifications')` 就在模块求值阶段抛错（LogBox 红框，catch 都不住）。
   已在 `runtime.ts` 用 `Constants.executionEnvironment === 'storeClient'` 判掉，Expo Go 里直接用
   空实现，App 干净启动；**想在设备上验证「到点真的会响」，必须走开发构建**
   （`expo-dev-client` / `npx expo run:android`），这同时也是极光推送的前置条件。

### 当前状态

- **测试基线**：Java **105**、Python **58**、App **170 + typecheck**、web-admin 18、合规门禁 19 项，全绿。
- **提醒链路现在是闭环的**：编辑页写入 → 服务端存设置 → App 对齐本机排期（重复日程按实例展开）→ 到点本地响 → 点击跳回那一次。
- **线上已更新**：2026-09-27 把新 jar 推到 `8.136.20.182`（备份在 `/opt/xatodo/backend/jar.bak-*`），
  实测 `GET /reminders/schedule` 401（路由存在且受保护）、App 冷启动会调它并拿到 200、
  `POST /tasks` 写入成功并且库里能查到。**服务端 + App 的写入链路已实测通**。
- **还没验证的只剩「本机通知真的响」**：Expo Go 跑不了（见上），需要开发构建。

### 下一步

1. **真机 / 模拟器走一遍提醒链路**（这是这一轮唯一没被验证的部分，也是上线前最该补的）。
2. 极光推送的 App 侧（Dev Client → `jpush-react-native` → registrationId 上报 → 点击路由复用本轮的 `notifications/route.ts`）。
3. 回归 §0.0（第五轮）里其余待办：B1 文档对齐、B2 后端 V18、B4 Web、B5 部署。

---

## 0.0 本次交接摘要（2026-09-27，第五轮）

**先看这两份**：[`docs/plan-2026-09-27.md`](docs/plan-2026-09-27.md)（**执行清单**，每批要做什么 + 已定决策）
与 [`docs/review-2026-09-27.md`](docs/review-2026-09-27.md)（review 结论，带证据）。

### 这一轮做完的

| # | 内容 | 提交 |
| --- | --- | --- |
| 1 | 上架合规（隐私政策同源 / 首启弹窗 / 非默认勾选 / 账号注销 / 权限告知） | `7d023fe` |
| 2 | 第一版去掉拍照识别（含相机权限与合规文本同步）；app.json 补图标/版本号/相册权限；生产切 `prod` profile + 启动自检 | `c7a1277` |
| 3 | 全量 review 结论（已修 6 项 / 待决策 20 项） | `0df7571` |
| 4 | **更名「时纪流 / ChronoFlow」**；包名 `com.chronoflow.frontend`、slug `chronoflow`；修 **R21**（两版 `setPassword` 都不吊销刷新令牌，与 spec §3.5 冲突） | `8e47d40` |
| 5 | 图标改用旧 ChronoFlow 的「时纪」字标（源图入库 + 派生脚本 `scripts/generate_app_icons.py`） | `32d7bac` |
| 6 | 极光推送的 **Expo 配置插件** `app/plugins/withJpush.js` + AppKey + 文档 | `730c6a3` |
| 7 | **服务端推送**：V17 `push_device`、`PushProvider` 极光实现、设备接口、组织下发触发 | `e47b6c9` |
| 8 | Python 版推送 + 契约（**106** 端点）+ spec §4.5/§5.12/§6.2；**已部署，V17 生效** | `bf02e11` |
| 9 | 执行清单落库 | `f81123c` |
| 10 | App 端重复规则与提醒排期的**纯逻辑层**（+22 项单测）；日程草稿接 `rrule`/`reminders`；客户端补 `PUT` | `0ef9c8b`、`865cd03` |
| 11 | 日程编辑页接「重复」「提醒」两条二级页；提醒写 `PUT /reminders` + `expo-notifications` 本地排期（映射表 / 先撤后排 / 删除取消），App 测试 131 → 147 | `e8c37d2` |
| 12 | 通知权限也走「先说明用途」（`askPermission('notification')`）+ 隐私政策权限清单同步；门禁改为「适配层之外不许直接申请权限」 | `72a4098` |

### 当前状态

- **线上**：`http://8.136.20.182:8088` 跑的是新版（`prod` profile、V17 已应用、生产配置自检通过）。
  `ping` / 合规文本 200，未登录调 `/me/push-devices` 401。
- **测试基线**：Java **102**、Python **55**、App **147 + typecheck**、web-admin 18、合规门禁 19 项，全绿。
- **凭证**：极光 AppKey 写在 `app.json` 的插件配置里（会编进 APK，本身公开）；
  **Master Secret 只在** `本地 .env.local` 与 `服务器 /opt/xatodo/.env`，两处都被 gitignore，
  compose 已透传 `JPUSH_APPKEY/JPUSH_MASTER_SECRET/JPUSH_APNS_PRODUCTION`。仓库里搜不到明文。
- **极光后台**：应用包名已登记 `com.chronoflow.frontend`（与 `app.json` 一致）；厂商通道**尚未配置**（按计划排到上架后）。

### 下一步（从第一条开始，细节在 `docs/plan-2026-09-27.md`）

1. ~~App 编辑页加「重复」与「提醒」两行~~ ✅ 已完成：`screens/RecurrencePickerScreen.tsx`、`screens/ReminderPickerScreen.tsx`；
   保存时写 `PUT /reminders` 并在本机排期（`notifications/scheduler.ts`：先撤旧再排新、删除时取消，
   映射表 `notifications/reminderStore.ts` 存安全存储）。**提醒链路还差尾巴**：重复日程只排了最近一次实例
   （30 天窗口 `horizonEnd` 还没有调用方，缺「启动时重排/换设备重排」）、通知点击的路由监听、
   「我的 → 通知」开关，以及**真机验证**（本机无模拟器，只做了单测 + typecheck）。
2. **推送的 App 侧**：Dev Client（`expo-dev-client` + `eas.json`）→ `jpush-react-native` →
   registrationId 上报 `POST /me/push-devices` → 通知点击统一路由。
   ⚠️ `app/plugins/withJpush.js` **还没经过真实 `expo prebuild` 验证**（注入正则在真模板上是否命中要跑一次才知道）。
3. 其余：隐藏小安 tab、请求超时、分页适配 → B1 spec 对齐 → B2 后端 V18（日志/配额/分页幂等/缓存异步导出/可观测/删全局配置）
   → B4 Web（`canEdit` + 已撤回筛选）→ B5 部署（`chronocloud.top` HTTPS + staging + **替换旧 ChronoFlow**）
   → B6 测试（组件渲染 / Maestro / P95）。

### 上架前仍需人工补的两处

1. `docs/legal/*.md` 里的 `【待替换：请填写客服邮箱/电话】`（`check_compliance.py --strict` 会报出来）；
2. 应用宝后台「基础信息 → 运营者 / 开发者」填 **舟山市时纪云人工智能应用软件开发有限公司**（与隐私政策主体一致）。

### 容易踩的坑（这一轮新增）

- **推送设备按账号找，不按身份找**：设备是「这台手机」的属性，用户在个人身份下上报，而组织日程要推给
  同一个人的组织身份。按身份查会一条都命不中（实现时踩过一次，`PushModuleTest` 有断言盯着）。
- **改密只吊销刷新令牌**：别顺手打「账号作废」标记 —— 那个标记会让旧访问令牌一律 20008，
  连本人用新密码重新登录都被挡住（实现时踩过一次）。
- **推送要在事务提交后发**：极光是外部 HTTP，放事务里既占连接，又会产生「事务回滚了但通知已发」的幻影通知。
- **品牌标记沿用旧仓库**：源图 `app/assets/brand/mark-1024.png` 取自 `github.com/XAXinAn/ChronoFlow`；
  它写的是两个字「时纪」，软件名是三个字「时纪流」——标记当图形资产沿用，改标记得先有设计稿。

## 0.0 本次交接摘要（2026-09-27，第四轮：应用商店上架合规）

**这一轮做了什么**：按应用宝《隐私政策提交内容及审核规范》把上架必备的那几条补齐。
需求与逐条对照写在 **spec §12**，人读的清单在 **`docs/legal/compliance-checklist.md`**，
机器门禁是 **`python3 scripts/check_compliance.py`**（CI 里会跑）。

1. **合规文本只有一份**：`docs/legal/*.md`（隐私政策 / 用户协议 / 儿童隐私声明 /
   已收集个人信息清单 / 与第三方共享个人信息清单）。Maven 打包时复制进 jar 的 `classpath:/legal/`，
   后端渲染成**纯静态 HTML** 挂在 `GET /api/v1/legal/{doc}`（免登录、无脚本、白名单 slug）。
   **App 用 WebView 打开同一个地址**——「App 内与链接内容完全一致」是结构上成立的，改文案不用发版。
   ⚠️ 不要为了「离线也能看」把正文抄进 App：`check_compliance.py` 的 `legal-single-source` 会拦。
2. **首启隐私政策弹窗**（`PrivacyConsentScreen`）：挂在根导航上，**在恢复会话与任何网络请求之前**；
   同意/不同意两个显式选项；同意记录存安全存储，隐私政策升版会自动重新弹。
3. **登录页改成主动勾选**：默认未勾选，未勾选时「登录 / 注册」与「获取验证码」都不可点；
   原来的「登录即表示同意…」已删（那正是审核点名的违规写法）。
4. **账号注销**：`POST /api/v1/me/deletion`，App 路径「我的 → 隐私与合规 → 账号注销」。
   立即生效：删个人数据、匿名化账号（释放手机号）、解绑组织、吊销令牌。
   **特别注意「访问令牌作废标记」**（见 §3.6 最后一条）：无名 JWT 光吊销刷新令牌是不够的。
5. **权限前说明**：相机 / 相册 / 定位统一走 `components/permission.ts` 的 `askPermission()`
   （先解释用途 → 再弹系统窗 → 拒绝只提示并可跳系统设置，**绝不退出 App**）。
6. **「我的」页新增「隐私与合规」分组**：五个文本入口 + 账号注销，主界面到隐私政策 3 步
   （规范要求 ≤ 4 步）。

**新增/改动的文件**：`docs/legal/*`、`scripts/check_compliance.py`、
`app/src/domain/{consent,permissions,legal}.ts`、`app/src/components/permission.ts`、
`app/src/auth/consentStore.ts`、`app/src/screens/{PrivacyConsent,Legal,AccountDeletion}Screen.tsx`、
`backend-java/xa-support/.../legal/*`、`backend-java/xa-auth/.../spi/AccountDataPurger.java`、
`backend-java/xa-bootstrap/.../compliance/JdbcAccountDataPurger.java`、
`backend-python/app/{routers,services}/legal.py`、两版的 `AccountRevocationStore`。

**测试基线**：Java **96**（含契约门禁 + 新增 `ComplianceTest` 3 项）、Python **54**（含 3 项）、
App **116** + typecheck、web-admin 18；`check_compliance.py` 19 项自动检查全绿。

**下一轮建议**：

1. 把 `docs/legal/*.md` 里剩下的 `【待替换：请填写客服邮箱/电话】` 换成真实联系方式
   （`python3 scripts/check_compliance.py --strict` 会报出来），并把应用宝后台的
   「运营者 / 开发者」填成 **舟山市时纪云人工智能应用软件开发有限公司**；
2. 部署到 8.136.20.182 后，把 `https://<域名>/api/v1/legal/privacy-policy`
   填进应用宝后台的「隐私政策 URL」，并在无痕窗口确认不用登录就能打开；
3. 剩下的产品项：拍照识别（端侧模型，排最后，见 §3.4）、web-admin 组织日历的 `canEdit`。

> **执行清单在 [`docs/plan-2026-09-27.md`](docs/plan-2026-09-27.md)**：那份把每批要做什么、
> 已定决策、以及「推送链路只剩 App 侧」这类进度都写清了，动手前先看它。
>
> **2026-09-27 又做了一轮上线前全量 review**，结论与逐条证据在
> [`docs/review-2026-09-27.md`](docs/review-2026-09-27.md)（含已修 6 项、待决策 20 项）。
> 先看那份再动手——里面 R1（提醒/推送整条链路不存在）、R2（明文 HTTP 可能导致 release 包连不上后端）
> 是会直接影响上线的两条。
>
> **同一轮确认的产品决定**：管理员模型保持现状——部门管理员由组织管理员在 **Web 组织管理端**设置，
> App 端不做成员/角色管理，也不设管理员数量上限。

### 0.0.1 同一天的产品删减：第一版不做「拍照识别」（2026-09-27）

**产品决定：第一版不上线拍照识别日程。** 因此把 App 侧的入口与实现整条删掉，
而不是留一个「点了必然失败」的按钮——那既伤用户信任，也会让上架的「功能完整性」检测难做。

- 删掉：日历页 / 组织页的「拍照」悬浮按钮、`RecognizedEventsScreen`、
  `app/src/vision/*`、`app/src/domain/vision.ts` 与 `app/test/vision.test.ts`、
  客户端的 `recognizeEvents` 接口与 `RecognizeResponse` 类型。
  现在两个页面右下角是**两个**悬浮按钮：跳到指定日期 / 新建。
- **相机权限一并去掉**：`app.json` 的 `expo-image-picker` 插件里设了
  `cameraPermission: false` 与 `microphonePermission: false`
  （该插件默认会给 iOS 加 `NSCameraUsageDescription`、给 Android 加 `RECORD_AUDIO`）。
  `domain/permissions.ts` 的 `PermissionKind` 现在只有 `photo` / `location`。
- **合规文本同步改了**：隐私政策 §2.7 / §9.2、用户协议 §四都去掉了相机与「拍照识别」，
  改写成「本应用不申请相机权限，也不提供拍照识别日程功能」。
  清单与实现必须一致，否则上架检测会判「声明与实际不符」。
- **后端 `POST /ai/events/recognize` 保留**（契约里还在、两版都有实现与测试）。
  将来重启该功能时，只需在 App 侧按 spec §4.1.9 原设计接回入口，不用动契约与两版后端。

**顺手补掉的三个上架硬阻塞（app.json 原本都没有）**：

1. **应用图标没有**：`expo.icon` / `android.adaptiveIcon.foregroundImage` 指向的文件不存在，
   store 构建会直接失败。已生成占位图标（`app/assets/{icon,adaptive-icon,splash}.png`，
   纯黑底 + 白色「日历 + 对勾」标记，贴合黑白极简的设计语言）——**正式发布前建议换成设计稿**。
2. **没有 `ios.buildNumber` / `android.versionCode`**：商店要求版本号单调递增，已补 `1`。
3. **没有配 `expo-image-picker` 插件**：iOS 的相册用途说明不会被写进 Info.plist。
   已补中文 `photosPermission`。

## 0.0 本次交接摘要（2026-09-26，第三轮）

**这一轮做了什么**（每条都有测试 + 实机证据，细节见 §3.1.1）：

1. **组织管理端（Web）打通，新组织能开张了**——上一轮记的「首位成员断点」已解决：
   `/api/v1/org-admin/**` 现在**同时接受**后台 `ORG_ADMIN` 的 `ADMIN` 令牌与 App 组织身份的 `ACCESS` 令牌
   （spec §3.2 / §4.3）。超管建组织时同步创建的那个后台管理员，登录 Web 组织管理端就能建部门、
   单个新增成员、批量导入，不必等组织里先有人认领。
2. **App 里也能下发组织日程了**：组织 tab 的悬浮按钮与日历页**同一套**（拍照 / 跳到指定日期 / 新建）；
   新建进整页表单，**下发对象 = 选人**——点「下发给」push 进独立选人页（按二级单位分组、搜姓名/工号/部门、
   整组全选、多选、顶部常驻已选列表）；提交的是**成员级名单**（`scopeType=MEMBER` + `memberIds`）。
3. **三条被纠正过、最终定稿的权限规则**（动手前务必按这个来，别照旧文档）：
   - 可选范围 = **我管得到的人**（`/org/current` 的 `manageableDepartmentIds`）。`GET /org/members`
     对普通成员会返回他自己，所以必须在**选择阶段**就过滤，否则「能选，但一点下发必然 403」。
     一个可下发的人都**没有**时，「新建」按钮根本不出现。
   - **发起人自己始终在收件名单里**：组织 tab 的列表口径是「发给我 / 我参与的」，
     不这么做的话「自己刚发的，自己日历里看不到」。
   - **改 / 撤 / 删只有发起人本人**，其他成员（**包括组织管理员**）一律只读；
     服务端返回 `canEdit`，App 的「编辑」入口按它显示，前端不猜权限。下发名单在编辑时不可改
     （换收件人 = 撤回 + 重新下发）。
4. **回执整条下线**（产品定「所有日程都不需要回执」）：组织日程与个人日程**长相一致**——
   卡片只有标题/时间/地点，没有回执按钮、没有「待回执」徽标。契约 104 → **101** 个端点；
   两版后端、App、Web 全清；DB 的 `require_receipt` / `receipt_status` 等列留作**遗留列**（不做破坏性迁移）。
5. **演示数据换成两个真实形态的组织**：`scripts/seed_demo_orgs.py` **全部走正式接口**（不直接写库）
   造出利欧数字（45 部门 / 118 人 / 四层）与浙江海洋大学（52 部门 / 261 人 / 三层）。
6. web-admin 补齐组织管理端五页 + 意见反馈页（菜单按角色渲染）；App 深色模式偏好持久化。

**顺带修掉的真问题**：

- 组织管理端缺的 6 个端点在两版后端都实现了并补进契约（98 → 104）：
  `GET /org-admin/departments`、`GET /org-admin/events`、`GET|PATCH /org-admin/settings`、
  `GET /org-admin/logs`、`GET /org-admin/imports/{id}/failures`。
- 迁移 **V15**：`event.creator_identity_id` 与 `event_dispatch.created_by_member_id` 放开非空，
  新增 `created_by_admin_id`（后台管理员没有 C 端身份，得有人认这笔下发）。
- 组织管理端的写操作**真的写审计日志**了；批量导入补上「只有组织管理员能导」的校验；
  多部分请求缺 `file` 部件从 90001 改成 400/10001；Python 版导入模板从旧 6 列改回 4 列。
- **撤回过的下发让成员端查询拼出 `IN ()` 直接 500**（空集合进 MyBatis-Plus `.in()`）——已修。
- Python 版 `receipt_summary` 里抄了一份权限判断没跟着改，导致「发起人看不了自己下发的」——已收敛到共用函数。

**验证证据**：Java **90** 项（含契约门禁）、Python **51** 项、App **98** 项 + typecheck、
web-admin **18** 项 + 生产构建，全绿；模拟器实机走通「组织页三按钮 → 新建 → 选人（搜索/整组全选/顶部已选）
→ 确定 → 下发 → 卡片与个人日程一致 → 发起人进编辑页改标题保存」。

**下一个 agent 从这里开始**（按优先级，详见 §3.4）：

1. **web-admin 组织日历的「撤回 / 删除」按钮现在对所有行都显示**，但后端只允许发起人操作 →
   非发起人点了会收到 20003。修法：`GET /org-admin/events` 的条目加 `canEdit`（服务端 `isInitiator` 判定），
   页面据此隐藏按钮。
2. **撤回之后这条日程在两端都查不到**（列表只列 ACTIVE 的下发），也没有「已撤回」入口。
   要做历史视图要么给列表加 `includeRevoked`，要么单独一个筛选。
3. **拍照识别（端侧）**——产品要求排最后，前置条件是 Dev Client 构建环境（§4.3）。

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

当前环境（2026-09-26 第三轮收尾时）**全部在跑**：PG 5432 / Redis 6379 / 后端 8080（带高德 Key）/ Metro 8081 / `emulator-5554`。
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

时纪流（ChronoFlow），智能日程与待办 App。项目代号 `xa-todo`（包名/环境变量等标识符沿用）。

- **App 端**：个人账号手动管理日历日程与待办；组织账号在此基础上增加组织管理员统一下发的组织日历。
- **Web 后台**：平台超管 + 组织管理员。
- 视觉风格：**黑白极简 · 高级质感 · 动态呼吸感**。

**`spec.md` 是唯一事实来源**。任何需求变更先改 spec，再改代码。改契约要同步改 `contract/api-contract.json` 和两版后端。

---

## 2. 当前进度

| 部分 | 状态 | 测试 |
| --- | --- | --- |
| spec.md | 完成（v1.2） | — |
| 跨语言契约 | `contract/api-contract.json`，**112 个端点** | Java 与 Python 各自校验 |
| backend-java（8 模块，含 `xa-support` 与 `xa-agent`） | 完成 | **150 项集成测试全绿** |
| backend-python（FastAPI 平行重写） | 完成，**契约覆盖率 100%** | **76 项全绿** |
| packages/design-tokens | 完成 | 8 个用例（1 个测试文件；`node --test` 汇总会显示 1） |
| web-admin（React + Vite + AntD） | 完成：超管六页 + **组织管理端五页** + 意见反馈 | 21 项 |
| app（React Native + Expo） | **核心流程可用**：日程/待办增删改、地图选点、组织日程（无回执，与个人日程同一长相）、**组织管理员在 App 内下发（选人页选下发对象）**、日历页检索（跨个人+所有组织）/滚轮跳转/节假日标记、头像上传、意见反馈、组织账号认领与账户管理、小安（对话 + 授权面板 + 长按说话）、**图片识别日程（端侧 OCR → 云端解析 → 确认页 → 草稿编辑器）**、深色模式偏好持久化 | **216 项**（**仅纯逻辑层，组件未做渲染测试**） |

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

> **读这一节时注意**：第 2、5、9、11 条里提到的「回执」已在**第 12 条整条下线**
> （产品定「所有日程都不需要回执」）。与回执冲突的描述一律以第 12 条为准。

| # | 需求 | 落地位置 | 证据 |
| --- | --- | --- | --- |
| 1 | **组织管理端入口（原「首位成员断点」）** | `AdminAuthenticationFilter` 现在也处理 `/org-admin/**`；新增 `xa-auth.AdminActor` 接口 + `xa-org.OrgActor` 执行者；`OrgPermissionService.resolveActor()` 同时认「组织身份」与「后台 ORG_ADMIN」；Python 侧 `deps.current_org_actor` + `OrgService.resolve_actor` | Java `OrgModuleTest.orgAdminConsoleCanOpenUpANewOrganization`（新组织 0 成员 → 建部门 → 新增成员 → 批量导入 → 成员认领 → 后台下发日程 → 操作日志）+ `orgConsoleTokenIsScopedAndMemberIsRejected`；Python 同名 2 项；真实环境 HTTP 冒烟：超管建组织 → 组织管理员建部门/成员 OK，成员令牌调管理端 20003、无令牌 20001 |
| 2 | **web-admin 组织管理端** | `pages/OrgSettingsPage / OrgMembersPage（含批量导入与失败明细）/ OrgDepartmentsPage / OrgEventsPage/ OrgLogsPage`；`AppLayout` 按角色渲染菜单 | `npm run build -w @xa-todo/web-admin` 通过；`OrgMembersPage.test.tsx` 盯着「已认领 / 待认领」与两个入口按钮 |
| 3 | **web-admin 意见反馈查阅** | `pages/FeedbackPage`（默认只看待处理，可切已处理/全部，图片预览，标记已处理） | `FeedbackPage.test.tsx`：默认 `status=OPEN`、处理后重新拉列表 |
| 4 | **深色模式偏好持久化** | `app/src/theme/preference.ts`（安全存储 + `nextScheme`），`AppContext` 启动时读回、切换时写回 | `app/test/themePreference.test.ts` 3 项；App 84 项 + typecheck 通过 |
| 5 | **组织管理端缺的端点补齐**（契约 98 → 104；第 12 条下线回执后为 101） | `GET /org-admin/departments`、`GET /org-admin/events`、`GET\|PATCH /org-admin/settings`、`GET /org-admin/logs`、`GET /org-admin/imports/{id}/failures`；Java 与 Python 两版都实现 | Java `OpenApiContractTest` 4 项通过（覆盖 + 安全声明 + 未带令牌 401） |
| 6 | **组织管理端的审计日志** | 新增 `OrgAuditSink`（定义在 xa-org，实现在 xa-admin，避免 xa-org 反向依赖）+ `OrgAuditRecorder`；Python 侧 `OrgService.record_org_audit`；在 controller/router 层逐端点记录 | 冒烟测试里 `GET /org-admin/logs` 返回 `ORG_DEPARTMENT_CREATE`、`ORG_MEMBER_CREATE` |
| 7 | **V15 迁移** | `event.creator_identity_id`、`event_dispatch.created_by_member_id` 放开非空；`event_dispatch` 新增 `created_by_admin_id` + CHECK（发起方恰有一列非空） | 开发库启动日志：`Successfully applied 2 migrations ... now at version v15` |
| 8 | 顺带修 | ①多部分请求缺 `file` → 现在 400/10001（原来掉进兜底返回 90001）；②批量导入补 `requireOrgAdmin`（spec §2.2）；③Python 导入模板从老的 6 列改回 4 列，与 Java 版和 spec §4.3 一致 | 冒烟时实测到 90001 才发现的第①条；②有 Java/Python 用例；③两版 `template()` 现在同列 |
| 9 | **组织管理员在 App 里下发日程**（spec §4.2.2 / §4.2.3） | 组织 tab 的悬浮按钮与日历页**同一套**（拍照 / 跳到指定日期 / 新建）；新建进整页表单（`OrgEventEditorScreen`），**下发对象 = 选人**：点那一行 push 到独立选人页（`OrgRecipientPickerScreen`）——按二级单位分组、可搜姓名/工号/部门、可整组全选、多选，**顶部常驻已选列表**（可逐个移除）。提交的是**成员级名单**（`scopeType=MEMBER` + `memberIds`）。**没有下发权限的人不出现、也不能选**：可选范围 = `/org/current` 的 `manageableDepartmentIds`（`GET /org/members` 对普通成员会返回他自己，必须在选择阶段就按这条规则过滤，否则就是「能选但一点下发必然 403」）。一个可下发的人都没有时，「新建」按钮根本不显示 | `app/test/orgDispatch.test.ts` 9 项 + `app/test/orgRecipients.test.ts` 6 项（按二级单位分组 / 搜索 / 整组全选 / **无权限的人不出现在列表**）；**模拟器实机走通**：浙海大 OWNER 选人下发 → 事件出现在组织日历（当时还带回执按钮，第 12 条已下线） |
| 11 | **发起人自己也收得到、也管得了自己下发的那条**（spec §4.2.2） | ①服务端展开收件人时**始终带上发起人自己**（组织 tab 的口径是「发给我 / 我参与的」，否则自己刚发的下一秒就看不见）；②**改 / 撤 / 删只有发起人本人**，其他成员只读——**组织管理员也不行**（已发给别人的通知，内容该由发的人负责）；③下发名单在编辑时**不可修改**（换收件人 = 撤回 + 重新下发）；⑤`OrgEventResponse` 新增 `canEdit`，App 的「编辑」入口按它显示，不自己猜权限 | Java `OrgModuleTest.initiatorSeesAndManagesOwnDispatch`（发起人可见 + 可改 + 同事 20003 + **管理员替人改也 20003** + 撤回放行）、Python 同名用例；既有 `dispatchToDepartmentAndMemberReceipt` 的期望从 2 改成 3（多出来的正是发起人） |
| 12 | **回执整条下线**（spec §4.2.2，产品定了「所有日程都不需要回执」） | 组织日程与个人日程**长相一致**：卡片只有标题/时间/地点，成员只读、发起人多一个「编辑」。删掉的东西：`POST /org/events/{id}/receipt`、`GET /org/events/{id}/recipients`、`GET /org-admin/events/{id}/receipts`（契约 104 → **101**）、两版后端的回执逻辑与看板回执率、App 的参加/不参加/已完成按钮与「待回执」徽标、Web 组织日历的回执列与回执明细抽屉、下发表单里的「要求回执」开关。`event_dispatch.require_receipt` 与 `event_recipient.receipt_status/receipt_at/remark` 保留为**遗留列**（不做破坏性迁移，代码不再读写其语义） | Java 90 / Python 51 / App 98 / web-admin 18 全绿 + 契约门禁；实机确认组织日程卡片与个人日程一致（无回执按钮、无待回执徽标） |
| 10 | 拍照入口在组织页也对齐（spec §4.1.9） | 组织页的拍照同样走「拍照/相册 → 上传 → 识别」，组织模式的识别确认页多一行「下发给」（点进同一个选人页），确认后批量下发；识别不可用时如实提示并给「手动新建组织日程」兜底。识别成功分支在模型接入前**无法端到端验证**（与日历页现状相同） | 实机确认按钮与入口存在；成功分支未验证（端侧模型未接入，后端返回 90002） |

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
| 1 | ~~拍照 / 相册识别日程~~ → **第一版不做（产品已定，见 §0.0.1）** | App 侧入口与实现已删除（含相机权限与合规文本）；**后端 `POST /ai/events/recognize` 与两版实现保留**，将来要接只需在 App 侧补入口（spec §4.1.9 留了原设计）。端侧模型仍未跑通（要 Dev Client 构建） |
| 1.5 | ~~**R1 提醒/通知/推送整条链路不存在**~~ ✅ **第六轮已闭环**（这条是旧快照，别照着做）：提醒走 `expo-notifications` **本地通知** + `GET /reminders/schedule` 对齐排期，推送走极光的 `push_device` 登记与组织日程推送 | 详见 §0.0 第六轮摘要 |
| 1.6 | **R2 明文 HTTP**：`apiBaseUrl` 是 `http://…:8088`，Expo 不注入 `usesCleartextTraffic`，Android 9+ 默认禁明文 → release 包可能连不上后端 | 上线前在真实 release 包里验证；首选上域名 + HTTPS（隐私政策 URL 也需要 HTTPS） |
| 2 | ~~超管建组织时预置首位拥有者成员~~ ✅ **已做** | 组织创建请求体加可选 `ownerMemberKey` / `ownerRealName`（两版后端都实现）：填了就同时建「总部」根部门 + 一条 OWNER 成员，组织一建好就能在 App 里认领；不填维持老行为（空组织）。web-admin 新建组织表单已加这两个选填项。契约文件**不用动**（只是请求体字段） |
| 3 | App 侧没有组织成员管理界面 | spec §4.3 把成员/部门管理划给 Web 组织管理端，App 只有组织日历（§4.2）。这是设计如此，不是遗漏；如果产品要求「拥有者在手机上也能导成员」，得先改 spec |
| 4 | ~~web-admin 组织日历的「撤回 / 删除」按钮口径不对~~ ✅ **已修** | `GET /org-admin/events` 的条目现在带 `canEdit`（服务端按 `isInitiator` 判定，两版后端都有），页面据此显示「撤回 / 删除」或「仅发起人可操作」。 |
| 5 | ~~撤回之后没有任何「已撤回」入口~~ ✅ **已修** | `GET /org-admin/events` 新增 `includeRevoked`（默认 false）；条目带 `status`（`ACTIVE`/`REVOKED`）。web-admin 组织日历加了「含已撤回」开关与「状态」列，已撤回的行不再给按钮。 |

App 侧选图用 `expo-image-picker`，取文件用 `expo-file-system` 的 `File`（原因见 §5 陷阱里的
「Expo SDK 57 的 fetch 不支持 `{uri,name,type}`」）。

### 3.5 App 界面未走查的部分（代码完成、测试绿，但没在模拟器里逐屏点过）

- 待办的图片附件（拍照入口 → 结果页）在**未接入模型**时的表现：只验到「如实提示」这一层，
  真正识别、编辑、批量创建这条链路没跑通过（端侧模型未就绪，见 §3.4 第 4 条）。
- 意见反馈的历史列表在数据较多时的滚动表现；「我的」页深色模式下的观感。
- **第三轮新增、只在真实环境用 HTTP 验过、没在浏览器里点过的**：web-admin 组织管理端五页 +
  意见反馈页（构建与组件测试都过，但没有人在浏览器里逐屏走过）。
- **组织页的拍照**：按钮与入口在实机确认过，但「识别成功后按条确认 + 选下发对象 + 批量下发」
  这一支要等端侧模型接入才能跑（现在后端返回 90002，走的是「如实提示 + 手动新建」兜底）。
- 回执整条下线之后，这块**没有遗留待验证项**了（原来记的「只验到待回执按钮」随第 12 条作废）。
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
- **同一条权限规则不要抄两遍**：Python 的 `receipt_summary` 里原本照抄了一份「组织管理员 / 部门范围」的判断，
  这次加「发起人也能看回执」时它没跟着改，表现成「发起人看不了自己下发的回执」。现在两版都收敛到
  `can_view_dispatch_stats` / `require_is_initiator` 这两个函数，改规则只改一处。
- **吊销刷新令牌 ≠ 让访问令牌失效**（第四轮踩到）：访问令牌是无状态 JWT，有效期 2 小时。
  只吊销刷新令牌只断掉「续期」，**已经签发出去的 access token 在此期间照样能用**——
  于是刚注销的账号还能再写两条日程，和隐私政策里承诺的「注销立即生效」直接冲突。
  现在注销 / 封禁时额外在 Redis 打 `revoked:acct:{id}`（TTL = 访问令牌有效期），
  Java 在 `JwtAuthenticationFilter`、Python 在 `deps.current_identity` 里解析完令牌再看一眼，
  命中即 `20008`。**新增任何「让账号立刻不可用」的路径时，这两步都要做。**
- **合规文本不要抄进 App**：`docs/legal/*.md` 是唯一事实来源，后端同源渲染成 HTML，
  App 用 WebView 打开同一地址。抄一份到 App 里，下一次改文案就必然一半新一半旧，
  而「App 内与商店链接内容必须完全一致」是硬性审核项。

### 3.7 演示数据集（2026-09-26 第三轮换成了两个真实形态的组织）

当前环境里的数据由 **`scripts/seed_demo_orgs.py`** 造出来，可重复执行（组织按编码、部门按父级+名称、
成员按唯一识别 ID 判重）：

```
backend-python/.venv/bin/python scripts/seed_demo_orgs.py            # 两个组织都建/补齐
backend-python/.venv/bin/python scripts/seed_demo_orgs.py --only ZJOU
# 组织 #1 利欧数字(LEODIGITAL)：45 个部门（总部→中心→部→组 四层）、118 名成员、44 位部门负责人
# 组织 #2 浙江海洋大学(ZJOU)：52 个部门（总部→学院→系 三层）、261 名成员、51 位部门负责人
# 两个组织的拥有者都是 App 登录账号 18006569106（工号 1145141919810 / 学号 2023210704127）
```

**这个脚本全部走正式接口**（组织管理端 API），不直接写库——上一版 `scripts/seed_demo_org.py`
直连数据库是因为「新组织没有入口创建首位成员」；那条断点已经在 §0.0 第 1 条里解决，
所以现在让种子脚本也走 API：**这条路一旦断，脚本会先炸**，比文档更早报警。
旧脚本保留但已过时（它造的是已经不存在的心安科技），读的时候别被它的注释误导。

生成的数据是确定性的（姓名、工号、学号都由固定序列推出），因此重跑会得到同一批人；
要彻底重来就先清空数据（§4.5），再跑脚本。

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
# 同一条也决定小安能不能用：.env.local 里没有 XATODO_AGENT_API_KEY 时，
# /system/info 的 aiAgentEnabled=false，App 会显示「还没有接入模型」（这是正常的降级，不是 bug）
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
- **当前演示数据**（2026-09-26 第三轮重建，见 §3.7）：两个组织 + 一个 App 账号
  - 利欧数字 `LEODIGITAL`：组织管理端账号 `leodigital_admin` / `leodigital123`
  - 浙江海洋大学 `ZJOU`：组织管理端账号 `zjou_admin` / `zjou123456`
  - App 登录账号 `18006569106`（个人账号，两个组织里都认领成 OWNER；工号 `1145141919810`、学号 `2023210704127`）
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
| Python 测试起不来（`pg_ctl ... returned non-zero`） | 嵌入式 PG 除了 unix socket 之外**还会绑 127.0.0.1:5432**，与开发库抢端口；`pg.log` 里是 `Address already in use` | 已修：`tests/conftest.py` 启动参数加了 `-c listen_addresses=''`（只监听 socket）。**不需要再停开发库** |
| Java 测试报 `SocketException: Operation not permitted` | 沙箱不允许绑监听端口，嵌入式 PG/Redis 起不来（表现为 `ApplicationContext failure`，看 surefire 报告里真正的 `Caused by`） | `mvn -B clean verify` 要提权；开发库不用停（zonky 用随机端口） |
| 关键词检索里的 `%` / `_` | 不转义就成了通配符：搜「50%」命中所有日程，即「搜什么都灵」 | SQL 写 `ILIKE :pattern ESCAPE '\'`，Java/Python 两边都要把 `\ % _` 转义；行为有测试守着 |
| Python 套件里无关用例报「验证码发送次数已达上限」 | 按 **IP** 的日限额在测试里没有意义（TestClient 的 client_ip 恒为 `testclient`，**整个套件共用一个计数器**），用例一多就随机变红 | `tests/conftest.py` 已把 `SMS_DAILY_LIMIT_PER_IP` 放开；手机号维度限额保持不变 |
| **测试里手机号必须全套件唯一（Java 与 Python 都是）** | 同一个号被两个用例注册（或同一用例发两次码）→ 撞 60 秒发送频控（`20005`），报的却是「发送过于频繁」，看不出是自己重号/重复发码。Redis 的 `sms:lock:{phone}` 是**跨用例共享**的 | 新增用例前先 `grep -rhoE '1[0-9]{10}' backend-python/tests/*.py \| sort -u`（Java 同理）数一遍；同一用例内要二次登录就直接往 Redis 里灌验证码，别再发一条 |
| Python 测试在**导入期**就 `import` 了 app 模块 | 收集阶段早于 conftest 的 `databases` fixture，`app.config` 会把 `DATABASE_URL`/`REDIS_URL` 冻在本地默认值上 → 整套用例跑去连**开发机那台真库**。症状有两个：`role "xatodo" does not exist`，或者（更隐蔽）**成片无关用例报 20005「验证码发送过于频繁」**——因为它们在打开发机的 Redis | 测试里**在用例函数内部**导入 `app.services.*` / `app.db` / `app.wiring`；conftest 里也写了醒目的注释 |
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
| **模拟器「卡死」，但截图看着很正常** | `adb shell echo` 能用、`screencap` 也能出图（其实是一帧静止画面），可 `dumpsys activity` 报 `DEAD_OBJECT`、`settings`/`input`/`wm size` 报 `Broken pipe` | 这是 guest 的 **system_server 挂了**，不是 App 卡住（差别很大：前者重启模拟器，后者 reload 一下就行）。判据就是上面那三条命令。恢复：`adb reboot` 会被吞掉（`cat /proc/uptime` 不变）；`adb emu kill` 后直接重启会**恢复坏的 quick-boot 快照**（uptime 还是旧的）→ 必须冷启动 `emulator.exe -avd Medium_Phone -no-snapshot-load`。冷启动后别忘 `adb reverse tcp:8081/8080` |
| **拿几分钟前的 bounds 去点新开的页面** | 编辑页有 `autoFocus` 时键盘会顶起布局，页面向上滚动，同一坐标在新页面上落到了别的控件——我因此在「新建组织日程」里误选了下发对象「指定部门」，还选了个部门，最后发出一条谁都没预期的全组织/部门日程 | **每一步点之前重新 `uiautomator dump`**，别复用上一次的坐标；点完再 dump 一次确认状态（这次就是靠「提示文案写着『指定部门』」和库里 `event_dispatch.scope_type` 才发现的）。自动化脚本里把「关键状态」也 dump 出来断言，别只看「点到了」 |
| **MyBatis-Plus 的空集合 `.in()`** | 撤回下发之后，成员端查自己的组织日程直接 **500**：`activeDispatchIds` 为空时 `.in(EventDispatch::getId, 空集合)` 拼出非法 SQL（`IN ()`），PG 报 `syntax error at or near ")"` | 空集合要**提前 return**，别把空 `IN` 交给数据库。是新增「撤回后成员端看不到」的用例才暴露出来的（Python 版用单条 SQL 带 `d.status='ACTIVE'`，没有这个问题） |
| **`git commit -m` 里写反引号** | 提交信息里写 `` `canEdit` `` 这类反引号会被 shell 当命令替换执行：终端打印 `command not found`，而**提交信息里那一段直接消失**（我两次都这么栽的，事后还得 `--amend`） | 带反引号/`$` 的提交信息一律用文件：apply_patch 写到 `/tmp/commit_msg.txt`，再 `git commit -F /tmp/commit_msg.txt`（`--amend` 同理） |
| **`curl` 里没转义时区偏移** | `?start=2026-09-01T00:00:00+08:00` 里的 `+` 会被当成空格，服务端解析不出时间 → 返回参数错误、`data` 为 null，看着像接口坏了 | 用 `urllib.parse.urlencode` / `--data-urlencode`，或把 `+` 写成 `%2B` |
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

Java 与 Python 两版后端**读同一份契约**做校验，共 **112 个端点**（含助手的三个端点，
第十二/十三轮加的；以及第十四轮加的 `POST /ai/events/parse-text`）。改动等于改契约，必须两版同步。

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
| App 侧的组织成员/部门管理 | spec §4.3 把这块划给 Web 组织管理端；App 只有组织日历（是设计，不是遗漏） |
| 微信 / 邮箱绑定 | 需要微信开放平台凭证与邮件通道，属外部依赖 |
| 真实短信通道、推送（极光）、对象存储（MinIO） | 外部依赖 |
| 后台 TOTP 双因素 | 未开始 |
| 端侧多模态模型（拍照识别日程里的识别环节） | 需要 Dev Client 构建环境（缺 NDK/CMake，见 §4.3）；产品已把这个功能排到最后 |
| App 的组件渲染测试 | 目前只覆盖纯逻辑层（`src/api`、`src/auth`、`src/domain`） |
| 性能验收（P95） | spec §10.5 要求但从未测过 |

---

## 9. 快速自检

### 9.0 已部署环境（2026-09-27）

线上演示环境：**http://8.136.20.182:8088**（Web 后台与 API 同源；App 的 `apiBaseUrl` 也指这里）。

| 项 | 说明 |
| --- | --- |
| 机器 | 阿里云 ECS，Ubuntu 22.04，2C/3.4G，SSH 密钥 `~/develop/workspace/XAXINAN.pem`（权限须 600） |
| 编排 | `/opt/xatodo/`：`docker-compose.yml` + `backend/`（fat jar + Dockerfile）+ `web/dist/` + `.env`；源文件在仓库 `deploy/` |
| 容器 | `xatodo-db`（postgres:16-alpine）、`xatodo-redis`、`xatodo-backend`（Temurin 21，`-Xmx512m`，只绑 `127.0.0.1:18080`） |
| 前端 | 用**宿主 nginx**（80/443 被宝塔既有站点占着，另加 8088 站点，见 `deploy/nginx-host.conf` → `/etc/nginx/conf.d/xatodo.conf`） |
| 账号 | 超管 `admin` / 见 `/opt/xatodo/.env` 的 `ADMIN_PASSWORD`；组织管理端 `leodigital_admin` / `leodigital123`、`zjou_admin` / `zjou123456`；App `18006569106` + 短信验证码 |
| 短信 | 复用同机 ChronoFlow 的阿里云短信凭据与模板（`.env` 里的 `ALIYUN_SMS_*`），已实测能收到；接了 aliyun 之后接口**不再回显验证码** |
| 演示数据 | 利欧数字 45 部门/117 人、浙江海洋大学 52 部门/260 人；两个组织各有一个可认领的拥有者成员（工号 `1145141919810` / 学号 `2023210704127`） |
| **合规文本（提交应用商店的隐私政策 URL）** | `http://8.136.20.182:8088/api/v1/legal/privacy-policy`（换成域名后同路径即可）。已实测：免登录 200、`text/html`、无 `<script>`；`user-agreement` / `children-privacy` / `personal-info-collected` / `shared-info-with-third-parties` 同前缀，未知 slug 返回 404 |

### 上线方式：**替换**掉现在跑着的 ChronoFlow（2026-09-27 确认）

本项目（中文名**时纪流**、英文名 **ChronoFlow**）是 ChronoFlow 的**新一版大迭代**。
上线路径不是「另起一个服务」，而是：

1. 新版先起来自测（本地 / staging），跑完测试与真机验收；
2. 验收通过后，**把服务器上现在运行的 ChronoFlow 服务关掉**，由新版接管；
3. 因此包名定为 `com.chronoflow.frontend`（ChronoFlow 的客户端身份），
   而不是按「时纪流」拼音另起一套命名空间。

替换前必须先确认的三件事（都还没定，动手前问清）：

- **接管哪个入口**：现有 ChronoFlow 的域名与端口由新版承接，还是新版用 `chronocloud.top` 另开入口？
  这决定 nginx 站点与证书怎么写。
- **旧数据怎么办**：现有 ChronoFlow 用的是自己的 MySQL（`ChronoFlow-mysql`），
  新版是 PostgreSQL 新 schema，两边不通用 —— 是不迁移、只保留旧库只读，还是要做一次数据搬迁？
- **极光推送是否复用**：现有 ChronoFlow 若已注册极光应用，直接复用它的 AppKey/MasterSecret
  最省事（但**应用里填的包名必须是 `com.chronoflow.frontend`**，包名不一致极光收不到推送）。

后端升级流程（只换 jar，DB / Redis 不动）：

```bash
# 本机
cd backend-java && JAVA_HOME=/home/jiang/tools/jdk-21.0.12.1+1 \
  /home/jiang/tools/apache-maven-3.9.16/bin/mvn -o -q -DskipTests package
ssh -i ~/develop/workspace/XAXINAN.pem root@8.136.20.182 \
  'cp -a /opt/xatodo/backend/xa-bootstrap-0.1.0-SNAPSHOT.jar /opt/xatodo/backend/jar.bak'
scp -i ~/develop/workspace/XAXINAN.pem \
  backend-java/xa-bootstrap/target/xa-bootstrap-0.1.0-SNAPSHOT.jar \
  root@8.136.20.182:/opt/xatodo/backend/
# 远端（注意：这台机器只有 docker-compose v1，没有 `docker compose` 子命令）
ssh -i ~/develop/workspace/XAXINAN.pem root@8.136.20.182 \
  'cd /opt/xatodo && docker-compose build backend && docker-compose up -d backend'
```

**两个坑**（都实际卡过）：①公网打不通要先看**阿里云安全组**，再看机器自己的 **ufw**——
这台机的 ufw 只放行了 22/80/443/8888 等，8088 需要 `ufw allow 8088/tcp`，只加安全组不够；
②`AliyunSmsSender` 曾因**两个构造器**导致 Spring 装配失败（`No default constructor found`），
只在 `provider=aliyun` 时暴露——本地默认 log 通道完全看不出来，是线上第一次启动才炸的。

```bash
# 后端（测试自带嵌入式 PG/Redis，无需外部依赖）
cd backend-java && mvn -B clean verify          # 期望 90 项全绿（需提权：沙箱不让绑端口）

# Python 后端（需要先跑 ./backend-python/scripts/setup-test-deps.sh）
# 注意：嵌入式 PG 要占 5432，跑之前先停开发库，跑完再启回来
cd backend-python && .venv/bin/python -m pytest  # 期望 51 项全绿

# 前端
npm run build -w @xa-todo/design-tokens
npm run build -w @xa-todo/web-admin
npm run typecheck -w @xa-todo/app
npm test                                        # 期望 design-tokens 8 例 + web-admin 18 项 + app 98 项全绿
```

CI 在 `.github/workflows/ci.yml`，三个 job：Java / Python / 前端。
