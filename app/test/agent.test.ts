import { describe, expect, it } from 'vitest';

import {
  AGENT_CAPABILITIES,
  AGENT_NAME,
  AGENT_STARTERS,
  AGENT_TAGLINE,
  describeAgentError,
} from '../src/domain/agent';
import { SERVER_ERROR_NOTICE } from '../src/domain/errors';

describe('智能助手入口（spec §11 阶段三）', () => {
  it('能力预告覆盖 spec 里承诺的三件事', () => {
    expect(AGENT_CAPABILITIES).toHaveLength(3);
    expect(AGENT_CAPABILITIES.join()).toContain('日程');
    expect(AGENT_CAPABILITIES.join()).toContain('冲突');
    expect(AGENT_CAPABILITIES.join()).toContain('历史');
  });

  it('内部状态不露给用户：没接入 / 上游挂了 / 内部错误都说成「稍后重试」', () => {
    // 用户不需要知道是「没配模型」还是「上游 500」——这两句都是实现细节
    expect(describeAgentError(90002, '小安还没有接入模型')).toBe(SERVER_ERROR_NOTICE);
    expect(describeAgentError(90001, '服务内部错误')).toBe(SERVER_ERROR_NOTICE);
    expect(SERVER_ERROR_NOTICE).toContain('稍后重试');
    expect(SERVER_ERROR_NOTICE).not.toContain('未接入');
    expect(SERVER_ERROR_NOTICE).not.toContain('模型');
  });

  it('登录态与业务报错要区别对待（一个是去重新登录，一个是照做）', () => {
    expect(describeAgentError(20002, '登录已过期')).toContain('重新登录');
    expect(describeAgentError(20003, '组织下发的日程要联系发起人处理'))
      .toBe('组织下发的日程要联系发起人处理');
  });

  it('有建议问法（空态是两列卡片，所以至少 4 条），不至于让人不知道怎么开口', () => {
    expect(AGENT_STARTERS.length).toBeGreaterThanOrEqual(4);
    expect(AGENT_NAME).not.toBe('');
    expect(AGENT_TAGLINE).not.toBe('');
  });

});
