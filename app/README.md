# @xa-todo/app

时纪流（ChronoFlow）App 端（React Native + Expo）。Expo SDK 57 / React Native 0.86 / React 19。

## 开发

```bash
npm run build -w @xa-todo/design-tokens   # App 依赖设计令牌
npm run typecheck -w @xa-todo/app
npm run test -w @xa-todo/app
npm run start -w @xa-todo/app             # 启动 Expo dev server
```

## 界面结构

## 图标与品牌标记

标记沿用旧 ChronoFlow 的**「时纪」字标**（细白描边圆头笔画、近黑底 `#21221D`），
源图在 `app/assets/brand/mark-1024.png`，取自旧仓库
`github.com/XAXinAn/ChronoFlow` 的 `frontend/assets/AppIcons/.../1024.png`。

全套图标由脚本派生，**不要手改产物**：

```bash
pip install pillow
python3 scripts/generate_app_icons.py          # 生成 icon / adaptive-icon / splash / store-512
```

注意源图写的是两个字「时纪」，而软件名是三个字「时纪流」——标记当作图形资产沿用，
名称变化不跟着改标记（要改标记得先有设计稿）。

| 页面 | 说明 |
| --- | --- |
| 首次启动 | **隐私政策同意页**：显著提醒 + 同意 / 不同意（spec §12.3，默认不勾选、同意前不发任何请求） |
| 登录 | 手机号 + 验证码；首次登录自动建号并创建个人身份；**默认未勾选**的协议复选框 |
| 日历 | 常驻搜索框 + 月视图（节假日「休/班」标记）+ 当日日程；右下角两个悬浮按钮：跳到指定日期 / 新建 |
| 待办 | 列表 + 快速添加 + 完成勾选（乐观更新）+ 图片附件 |
| 组织 | 组织日程（成员只读、发起人可编辑）；下发入口按权限出现；可认领多个组织账号 |
| 小安 | 智能助手**占位页**：如实说明「还没有接入模型」（spec §11 阶段三） |
| 我的 | 头像 / 深色模式 / 意见反馈 / **隐私与合规**（隐私政策、用户协议、儿童声明、双清单、账号注销）/ 退出登录 |

> 「拍照 / 相册识别日程」**第一版不做**，App 侧入口与实现已删除，也不申请相机权限（spec §4.1.9）。

## 会话保持（spec §3.7）

这是「用户不感知重新登录」的落地位置，`src/auth/session.ts` 承担两件事：

1. **提前刷新**：剩余有效期不足 5 分钟时，先刷新再发请求，避免卡在过期瞬间。
2. **单飞刷新**：同一时刻只允许一个刷新请求在途，其余调用共享同一个 Promise。

第 2 点关键——冷启动时 App 会并发发起多个请求，若各自去刷新，
服务端轮换会让后到的请求拿着已被换掉的令牌而失败，用户就被踢到登录页了。
服务端侧另有 60 秒轮换宽限期兜底，两层保障叠加。

`src/api/client.ts` 负责另一半：收到 `20001` / `20002` 时静默刷新一次并**重放原请求**，
用户完全无感知。若连鉴权令牌都拿不到，则直接回调 `onSessionExpired` 跳登录页——
不白跑一趟后端。

## 测试范围

当前 **109 项**测试覆盖**纯逻辑层**（`src/api`、`src/auth`、`src/domain`），
这些模块刻意不 import `react-native`，因此可以在 node 环境下直接运行，
无需 jest-expo 与原生渲染环境。

组件渲染测试与模拟器联调尚未进行，见下节。

## 模拟器调试（本机环境实测结论）

开发机是 Windows + WSL2。**WSL 内没有 `/dev/kvm`，无法运行 Android 模拟器**，
必须用 Windows 侧已安装的 SDK：

```bash
# 1) Windows 侧启动模拟器（PowerShell / CMD）
%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe -avd Medium_Phone

# 2) WSL 侧确认设备（沙箱内调用 .exe 需授权）
adb.exe devices

# 3) 启动 dev server
npm run start -w @xa-todo/app

# 4) 端口反向映射，让模拟器能回连 WSL 内的 dev server
adb.exe reverse tcp:8081 tcp:8081
# 若要访问 WSL 内的后端，也把它映射过去
adb.exe reverse tcp:8080 tcp:8080
```

后端地址在 `app.json` 的 `extra.apiBaseUrl`，当前指向线上演示环境
`http://8.136.20.182:8088`（与 Web 后台同源）。本地联调时改成
`http://localhost:8080`（配合上面的 `adb reverse`）或 `http://10.0.2.2:8080`。

**iOS 模拟器在当前环境不可用**（需要 macOS + Xcode），只能走真机 Expo Go 或 EAS 云构建。
