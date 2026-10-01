# @chronoflow/web-admin

时纪流（ChronoFlow）Web 后台：平台超管端（spec §4.4）+ 组织管理端（spec §4.3）。
React 18 + Vite + TypeScript + Ant Design 5，**菜单按登录管理员的角色渲染**。

> 选 React 18 而非 19：antd 5 在 React 19 下需要额外的兼容补丁包，当前阶段没必要引入这个变数。

## 开发

```bash
# 先构建设计令牌（web-admin 依赖它）
npm run build -w @chronoflow/design-tokens

# 启动开发服务器（默认 http://127.0.0.1:5173）
npm run dev:web

# 生产构建 / 测试
npm run build -w @chronoflow/web-admin
npm run test  -w @chronoflow/web-admin
```

后端地址通过环境变量注入（见 `.env.example`）：

```bash
VITE_API_BASE_URL=http://localhost:8080
```

默认后端账号由 `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD` 决定，
本地开发默认是 `admin` / `admin123456`。

## 已实现页面

| 路由 | 功能 |
| --- | --- |
| `/login` | 管理员登录 |
| `/` | 数据看板（组织、账号、成员、日程、待办、下发与回执） |
| `/organizations` | 组织列表、新建（含首位管理员）、停用/启用、删除 |
| `/accounts` | 账号检索、封禁/解封、身份停用、强制登出 |
| `/admins` | 后台管理员列表、新建、重置密码、停用 |
| `/configs` | 全局配置查看与编辑 |
| `/audit-logs` | 审计日志检索与 CSV 导出 |
| `/feedback` | 意见反馈查阅：默认只看待处理，可切换状态、预览图片、标记已处理 |

组织管理端（登录账号是带 `org_id` 的 `ORG_ADMIN` 时显示这一套菜单）：

| 路由 | 功能 |
| --- | --- |
| `/org/settings` | 组织设置（名称、Logo、联系方式、时区；成员上限只读） |
| `/org/members` | 成员列表、单个新增/编辑/停用、解绑组织账号、批量导入与失败明细 |
| `/org/departments` | 部门树增删改、设置/撤销部门负责人 |
| `/org/events` | 下发组织日程、回执统计与明细、撤回/删除 |
| `/org/logs` | 本组织的操作日志 |

> **为什么组织管理端能开张**：新组织建好时成员数为 0，而这一整套管理动作都在组织内进行。
> 后端 `/api/v1/org-admin/**` 因此同时接受后台 `ORG_ADMIN` 的 `ADMIN` 令牌（本端）
> 与 App 侧组织身份的 `ACCESS` 令牌（spec §3.2 / §4.3）。

## 几个实现约定

**统一响应体处理**：后端业务可预期错误也返回 HTTP 200，语义在 `code` 里（spec §6.1）。
因此 `api/client.ts` **同时**看 HTTP 状态和业务码：

- `code !== 0` → 抛 `ApiError`，保留 `code` 与 `traceId` 便于排查
- `20001 / 20002`（未登录 / 过期）→ 清会话并跳登录页
- `20003`（无权限）→ **不清会话**，仅提示，避免一次越权就把用户踢出去

**设计令牌**：所有颜色、间距、圆角、动效都来自 `@chronoflow/design-tokens`，
通过 `data-cf-theme` 切换 CSS 变量，并把同一套令牌交给 Ant Design `ConfigProvider`，
保证自定义样式与组件库同源（spec §7.6.6）。业务组件里不应出现硬编码色值。

**导出接口**：审计日志导出需要 `Authorization` 头，普通 `<a href>` 带不上令牌，
因此改为取回 CSV 文本后触发 Blob 下载。

## 测试

Vitest + Testing Library，18 项：统一响应体与错误码分支、会话过期与存储异常降级、
登录成功/失败流程、意见反馈的默认筛选与处理动作、组织成员页的认领状态与入口。
