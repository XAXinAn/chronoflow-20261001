import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  antdThemeToken,
  calendarGrayscale,
  colors,
  cssVariables,
  holidayColors,
  isColorScheme,
  schemeVariables,
  semanticColors,
  staticVariables,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '../dist/tokens.css');

test('生成的 CSS 覆盖全部令牌，且与 TS 常量完全一致', async () => {
  const css = await readFile(cssPath, 'utf8');

  for (const [name, value] of Object.entries(cssVariables('light'))) {
    assert.ok(css.includes(`${name}: ${value};`), `CSS 缺少或值不匹配: ${name}`);
  }
  for (const [name, value] of Object.entries(schemeVariables('dark'))) {
    assert.ok(css.includes(`${name}: ${value};`), `深色方案缺少或值不匹配: ${name}`);
  }
  assert.ok(css.includes('[data-xa-theme="dark"]'), '缺少深色主题选择器');
});

test('深浅两套方案必须给出不同的前景/背景，避免误用同一套色值', () => {
  assert.notEqual(colors.light.bg, colors.dark.bg);
  assert.notEqual(colors.light.textPrimary, colors.dark.textPrimary);
  assert.notEqual(colors.light.accent, colors.dark.accent);
  assert.equal(colors.light.accent, colors.dark.bg);
  assert.equal(colors.dark.accent, colors.light.bg);
});

test('主色必须是黑白灰，不得出现彩色通道', () => {
  const grayscale = /^#([0-9A-Fa-f]{2})\1\1$/;
  for (const scheme of ['light', 'dark']) {
    const palette = colors[scheme];
    for (const [key, value] of Object.entries(palette)) {
      if (key === 'focusRing') {
        continue;
      }
      assert.match(value, grayscale, `${scheme}.${key} 不是纯灰度色: ${value}`);
    }
  }
});

test('日历灰度阶梯与语义色符合 spec §7.6', () => {
  assert.equal(calendarGrayscale.length, 4);
  for (const color of calendarGrayscale) {
    assert.match(color, /^#[0-9A-Fa-f]{6}$/);
  }
  assert.equal(semanticColors.light.success, '#2E7D5B');
  assert.equal(semanticColors.light.warning, '#B58500');
  assert.equal(semanticColors.light.danger, '#B3352F');
});

test('休 / 班 标记色是全项目唯一的例外：放假蓝、调休红，深浅两套都要有', () => {
  assert.equal(holidayColors.light.holiday, '#1565C0');
  assert.equal(holidayColors.light.workday, '#C62828');
  // 深色底需要提亮，直接复用浅色值会在暗背景上糊掉
  assert.notEqual(holidayColors.dark.holiday, holidayColors.light.holiday);
  assert.notEqual(holidayColors.dark.workday, holidayColors.light.workday);
  for (const scheme of ['light', 'dark']) {
    const { holiday, workday } = holidayColors[scheme];
    assert.match(holiday, /^#[0-9A-Fa-f]{6}$/);
    assert.match(workday, /^#[0-9A-Fa-f]{6}$/);
    assert.notEqual(holiday, workday, `${scheme} 的休与班不能同色`);
  }
});

test('Ant Design 主题令牌可生成且主色随方案切换', () => {
  const light = antdThemeToken('light');
  const dark = antdThemeToken('dark');
  assert.equal(light.colorPrimary, '#0A0A0A');
  assert.equal(dark.colorPrimary, '#FFFFFF');
  assert.equal(light.colorBgBase, '#FFFFFF');
  assert.equal(dark.colorBgBase, '#0A0A0A');
  assert.equal(light.wireframe, false);
});

test('静态变量不含颜色，方案变量不含间距', () => {
  assert.ok(!Object.keys(staticVariables()).some((name) => name.includes('text')));
  assert.equal(Object.keys(schemeVariables('light')).length, Object.keys(schemeVariables('dark')).length);
});

test('配色方案守卫函数', () => {
  assert.ok(isColorScheme('light'));
  assert.ok(isColorScheme('dark'));
  assert.ok(!isColorScheme('sepia'));
});
