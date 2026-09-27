/**
 * 合规文本的入口表。
 *
 * App **不内嵌**这些文本，只用 WebView 打开后端同一个地址
 * （`GET /api/v1/legal/{doc}`）。这样「App 内展示内容与链接内容完全一致」是天然成立的，
 * 而不是靠人工比对维持——审核规范 §一-1 正是要求这一条。
 */

export type LegalDoc =
  | 'privacy-policy'
  | 'user-agreement'
  | 'children-privacy'
  | 'personal-info-collected'
  | 'shared-info-with-third-parties';

export interface LegalEntry {
  /** 页面标题（导航栏与「我的」页共用） */
  title: string;
  /** 列表项副标题 / 首启弹窗里的名称 */
  label: string;
}

export const LEGAL_DOCS: Record<LegalDoc, LegalEntry> = {
  'privacy-policy': { title: '隐私政策', label: '《心安待办隐私政策》' },
  'user-agreement': { title: '用户服务协议', label: '《心安待办用户服务协议》' },
  'children-privacy': {
    title: '儿童个人信息保护声明',
    label: '《心安待办儿童个人信息保护声明》',
  },
  'personal-info-collected': { title: '已收集个人信息清单', label: '已收集个人信息清单' },
  'shared-info-with-third-parties': {
    title: '与第三方共享个人信息清单',
    label: '与第三方共享个人信息清单',
  },
};

/** 合规文本的公开地址。**这就是提交到应用商店后台的那个链接**。 */
export function legalUrl(baseUrl: string, doc: LegalDoc): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/legal/${doc}`;
}

/**
 * 运营主体名称。**必须**与 `docs/legal/privacy-policy.md` 的「一、导言」、
 * 以及应用商店后台「基础信息 → 运营者」三处完全一致（规范 §2.2）。
 *
 * 提交审核前把这里和文档里的 `【待替换：…】` 一起换掉——`scripts/check_compliance.py`
 * 会检查文档侧，这里由 `docs/legal/README.md` 的发版清单兜底。
 */
export const OPERATOR_NAME = '舟山市时纪云人工智能应用软件开发有限公司';

/** App 版本号，与 app.json 的 expo.version 保持一致。 */
export const APP_VERSION = '0.1.0';
