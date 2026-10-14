/**
 * 后台「全局配置」里那几个功能开关的客户端口径（spec §5.7）。
 *
 * <p>超管在后台改一下开关，App 下次进「我的」就能看到入口消失 / 回来，不用发版。
 * **读不到一律按开**：一次网络抖动不该把反馈、实名这些入口藏起来 —— 用户只会以为 App 坏了。
 */

export interface FeatureFlags {
  /** 意见反馈入口 */
  feedback: boolean;
  /** 实名认证入口 */
  realName: boolean;
  /** 邮箱绑定入口 */
  emailBinding: boolean;
  /** 小安（智能助手）是否可用 */
  agent: boolean;
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  feedback: true,
  realName: true,
  emailBinding: true,
  agent: true,
};

/** 容错归一：缺字段 / 类型不对一律按 true（与后端「读不到按开」的取舍一致）。 */
export function parseFeatureFlags(raw: unknown): FeatureFlags {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_FEATURE_FLAGS };
  }
  const source = raw as Record<string, unknown>;
  const read = (key: keyof FeatureFlags) =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : DEFAULT_FEATURE_FLAGS[key];
  return {
    feedback: read('feedback'),
    realName: read('realName'),
    emailBinding: read('emailBinding'),
    agent: read('agent'),
  };
}
