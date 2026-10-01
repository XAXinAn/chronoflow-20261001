/**
 * 昵称（「名字」）的纯校验逻辑（spec §4.1.8 / §6.2）。
 *
 * 上限跟服务端对齐：Java `UpdateProfileRequest.nickname` 是 `@Size(max = 32)`，
 * 两版后端都按同一份 DTO 走。前端先挡一道只是为了让用户少跑一次往返，
 * **服务端仍然是唯一权威**（超长、空白都以它为准）。
 */

/** 与服务端 `@Size(max = 32)` 一致。 */
export const MAX_NICKNAME_LENGTH = 32;

/**
 * 去掉首尾空白并折掉内部换行。
 *
 * 换行不折的话，界面上那行昵称会被撑成两行（列表高度会跳），而用户看不出自己输了换行
 * ——粘贴一段带换行的文本时很常见。
 */
export function normalizeNickname(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * 校验昵称；返回 null 表示没问题，否则给一句能照做的提示。
 *
 * 名字只是显示用的标签，不做实名、也不限制字符种类（中英文、emoji 都可以）。
 */
export function validateNickname(value: string): string | null {
  const normalized = normalizeNickname(value);
  if (!normalized) {
    return '名字不能为空';
  }
  // 用码点长度而不是 UTF-16 长度：一个 emoji 在 JS 里是 2 个 char，按后者算会误判超长
  if ([...normalized].length > MAX_NICKNAME_LENGTH) {
    return `名字最多 ${MAX_NICKNAME_LENGTH} 个字`;
  }
  return null;
}

/** 界面上显示的名字：空值统一成「未命名」（本地会话里 nickname 可以是 null）。 */
export function displayName(nickname: string | null | undefined): string {
  const normalized = normalizeNickname(nickname ?? '');
  return normalized || '未命名';
}
