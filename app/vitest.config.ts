import { defineConfig } from 'vitest/config';

/**
 * 只对**纯逻辑层**跑测试（api / domain / session）。
 *
 * 这些模块刻意不 import react-native，因此可以直接在 node 环境运行，
 * 无需 jest-expo 与原生渲染环境。组件渲染测试要等模拟器联调那一步再补。
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
  },
});
