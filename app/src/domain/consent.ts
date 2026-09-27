/**
 * 隐私政策同意的纯逻辑（spec §12；应用宝《隐私政策提交内容及审核规范》§四）。
 *
 * 审核明确点名过两种违规写法：**默认勾选**、以及**「注册或登录即表示同意」**。
 * 因此这里把「能不能登录」这件事抽成纯函数：界面只负责渲染，判定由单测盯着。
 */

/** 当前生效的隐私政策版本。改了 docs/legal/privacy-policy.md 的版本号就要同步这里。 */
export const PRIVACY_POLICY_VERSION = '1.0';

export interface ConsentRecord {
  version: string;
  /** ISO 时间串，留痕用（万一将来需要证明「用户在哪一版同意了」） */
  acceptedAt: string;
}

export interface LoginGateInput {
  phone: string;
  code: string;
  /** 用户是否主动勾选了「我已阅读并同意…」——**默认必须是 false** */
  acceptedPolicy: boolean;
}

export function buildConsentRecord(
  version: string = PRIVACY_POLICY_VERSION,
  now: Date = new Date(),
): ConsentRecord {
  return { version, acceptedAt: now.toISOString() };
}

/**
 * 是否需要对当前版本重新征求同意。
 *
 * 记录缺失 → 要弹；记录的版本与当前版本不一致 → 也要弹（规范 §2.4：规则变更要重新取得同意）。
 */
export function hasAcceptedPolicy(
  record: ConsentRecord | null | undefined,
  currentVersion: string = PRIVACY_POLICY_VERSION,
): boolean {
  if (!record) {
    return false;
  }
  return record.version === currentVersion;
}

/** 登录按钮是否可点。三条都满足才放行——少一条就会出现「没勾同意也能登」。 */
export function canSubmitLogin(input: LoginGateInput): boolean {
  return input.phone.trim().length === 11
    && input.code.trim().length === 6
    && input.acceptedPolicy;
}

/**
 * 「获取验证码」要不要放行。
 *
 * 这里**也**要求先勾选同意：发一条验证码，服务端就已经把手机号交给短信服务商了，
 * 那是货真价实的个人信息处理。与其在弹窗里解释「发码不算收集」，不如直接要求先同意
 * （首启弹窗已经同意过一次，这里只是登录页的再次确认）。
 */
export function canRequestCode(
  phone: string,
  cooldownSeconds: number,
  acceptedPolicy: boolean,
): boolean {
  return phone.trim().length === 11 && cooldownSeconds <= 0 && acceptedPolicy;
}
