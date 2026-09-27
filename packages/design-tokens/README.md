# @xa-todo/design-tokens

时纪流设计令牌的**唯一来源**（spec §7.6）。Web 后台与 App 端都从这里取值，禁止在业务组件里硬编码色值。

```bash
npm run build -w @xa-todo/design-tokens   # 产出 dist/index.js 与 dist/tokens.css
npm run test  -w @xa-todo/design-tokens   # 校验 CSS 与 TS 同源
```

## 消费方式

Web（CSS 变量由 `dist/tokens.css` 提供）：

```css
.card {
  background: var(--xa-surface-raised);
  border: 1px solid var(--xa-border);
  border-radius: var(--xa-radius-card);
}
```

Ant Design 主题：

```ts
import { antdThemeToken } from '@xa-todo/design-tokens';
<ConfigProvider theme={{ token: antdThemeToken(scheme) }} />
```

App（TS 常量）：

```ts
import { colors, spacing, radius } from '@xa-todo/design-tokens';
```

## 设计约束（有测试守着）

- **主色必须是纯黑白灰**：`colors` 下除 `focusRing` 外全部要求形如 `#RRGGBB` 且三通道相等。
- **深浅两套必须真正不同**，且深色主色 = 浅色底色、浅色主色 = 深色底色。
- **CSS 与 TS 必须同源**：`dist/tokens.css` 由 `scripts/emit-css.mjs` 生成，测试逐个变量比对，手改 CSS 会失败。
- **语义色降饱和**：仅用于状态提示，不作为主色。
- 系统开启「减少动态效果」时，CSS 里已预置 `prefers-reduced-motion` 降级。
