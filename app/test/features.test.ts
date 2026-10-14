import { describe, expect, it } from 'vitest';

import { DEFAULT_FEATURE_FLAGS, parseFeatureFlags } from '../src/domain/features';

describe('后台功能开关（全局配置）', () => {
  it('后端明确关掉的入口就是关的', () => {
    expect(
      parseFeatureFlags({ feedback: false, realName: true, emailBinding: false, agent: true }),
    ).toEqual({ feedback: false, realName: true, emailBinding: false, agent: true });
  });

  it('缺字段按「开」：一次响应不完整不该把入口藏起来', () => {
    expect(parseFeatureFlags({ agent: false })).toEqual({ ...DEFAULT_FEATURE_FLAGS, agent: false });
  });

  it('拿不到 / 类型不对都退回全开', () => {
    expect(parseFeatureFlags(null)).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(parseFeatureFlags({ feedback: 'no' })).toEqual(DEFAULT_FEATURE_FLAGS);
  });
});
