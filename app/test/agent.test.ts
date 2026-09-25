import { describe, expect, it } from 'vitest';

import {
  AGENT_CAPABILITIES,
  AGENT_NAME,
  AGENT_OFFLINE_NOTICE,
  AGENT_STARTERS,
  agentIsOffline,
} from '../src/domain/agent';

describe('智能助手入口（spec §11 阶段三）', () => {
  it('能力预告覆盖 spec 里承诺的三件事', () => {
    expect(AGENT_CAPABILITIES).toHaveLength(3);
    expect(AGENT_CAPABILITIES.join()).toContain('日程');
    expect(AGENT_CAPABILITIES.join()).toContain('冲突');
    expect(AGENT_CAPABILITIES.join()).toContain('历史');
  });

  it('未接入模型时必须明说，不能装成能用', () => {
    // 这条断言是给未来的自己留的：真要接入模型时，agentIsOffline 必须一起改掉，
    // 否则界面会一边能用、一边还在说「没有接入模型」
    expect(agentIsOffline()).toBe(true);
    expect(AGENT_OFFLINE_NOTICE).toContain('没有接入模型');
    expect(AGENT_OFFLINE_NOTICE).toContain('手动创建');
  });

  it('有建议问法，空输入框时不至于让人不知道怎么开口', () => {
    expect(AGENT_STARTERS.length).toBeGreaterThan(0);
    expect(AGENT_NAME).not.toBe('');
  });

});
