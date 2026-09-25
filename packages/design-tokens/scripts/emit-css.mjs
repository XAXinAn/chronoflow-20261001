/**
 * 由 TS 令牌生成 CSS 变量文件。
 *
 * 生成而非手写，是为了让 Web 端消费的 CSS 与 App 端消费的 TS 常量**必然同源**；
 * 任何漂移都会被 test/tokens.test.mjs 拦下。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cssVariables, staticVariables, schemeVariables } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '../dist/tokens.css');

function block(selector, variables, indent = '  ') {
  const lines = Object.entries(variables).map(([name, value]) => `${indent}${name}: ${value};`);
  return `${selector} {\n${lines.join('\n')}\n}`;
}

const css = [
  '/* 由 @xa-todo/design-tokens 自动生成，请勿手改；改动请编辑 src/tokens.ts */',
  '',
  block(':root', staticVariables()),
  '',
  block(':root, [data-xa-theme="light"]', schemeVariables('light')),
  '',
  block('[data-xa-theme="dark"]', schemeVariables('dark')),
  '',
  '@media (prefers-reduced-motion: reduce) {',
  '  :root {',
  '    --xa-duration-enter: 120ms;',
  '    --xa-duration-exit: 120ms;',
  '    --xa-duration-spring: 120ms;',
  '  }',
  '}',
  '',
].join('\n');

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, css, 'utf8');

const total = Object.keys(cssVariables('light')).length;
console.log(`已生成 ${outputPath}（${total} 个变量）`);
