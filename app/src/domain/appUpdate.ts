/**
 * 「应用内更新」的判定逻辑（spec §4.1.11）——纯函数，可单测。
 *
 * <p>三件事都不碰原生，所以放在 domain 里：**要不要更新**、**能不能跳过**、
 * **安装包地址怎么拼**。真正下载与调系统安装器在 `updater/` 里（那是原生能力）。
 *
 * <p>最要紧的一条：**服务端没配置发布信息时，绝不能编出一个更新来**。
 * 版本发布是运维配置，配漏了最坏的结果是全员被挡在强制更新页——所以这里的每个
 * 边界都往「不打扰用户」的方向倒。
 */

import type { AppRelease } from '../api/appRelease';

/** 一次版本比较的结论。 */
export type UpdateDecision =
  | { kind: 'none' }
  /** 有新版，用户可以选择「稍后」 */
  | { kind: 'optional'; release: AppRelease }
  /**
   * 必须更新。`reason` 只用于文案：
   * `force` = 发布方标了强制；`unsupported` = 本地版本低于服务端支持下限。
   */
  | { kind: 'force'; release: AppRelease; reason: 'force' | 'unsupported' };

function versionCodeOf(release: AppRelease | null | undefined): number {
  const raw = release?.versionCode;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.floor(raw);
}

/**
 * 比对本地版本与线上发布信息。
 *
 * @param localVersionCode 本机安装包的 `versionCode`；**读不到就传 0**
 * @param release          服务端返回的发布信息
 *
 * <p>读不到本地版本号（0）时**一律判定为「没有更新」**：Expo Go / Web / 读不到
 * 原生版本的环境不该被一个自己都说不清版本的客户端弹窗骚扰，更不该被强制更新拦住。
 */
export function decideUpdate(
  localVersionCode: number,
  release: AppRelease | null | undefined,
): UpdateDecision {
  const target = versionCodeOf(release);
  const apkUrl = (release?.apkUrl ?? '').trim();
  // 没有版本号或没有包地址 = 没配置发布信息（或配置写漏了）→ 当没有更新
  if (target === 0 || !apkUrl) {
    return { kind: 'none' };
  }
  const local = typeof localVersionCode === 'number' && Number.isFinite(localVersionCode)
    ? Math.floor(localVersionCode)
    : 0;
  if (local <= 0 || local >= target) {
    return { kind: 'none' };
  }

  const minSupported = release?.minSupportedVersionCode ?? 0;
  const belowMinimum = typeof minSupported === 'number' && minSupported > 0 && local < minSupported;
  if (release?.force === true || belowMinimum) {
    return { kind: 'force', release: release as AppRelease, reason: belowMinimum ? 'unsupported' : 'force' };
  }
  return { kind: 'optional', release: release as AppRelease };
}

/**
 * 安装包地址：绝对 URL 原样用；相对路径拼当前 API 域名。
 *
 * <p>拼 baseUrl 而不是把域名写进服务端配置：换域名 / 上 CDN 时只改一处
 * （与头像、待办图片的 `/uploads/**` 同一个规矩）。
 */
export function resolveApkUrl(apkUrl: string | null | undefined, baseUrl: string): string {
  const path = (apkUrl ?? '').trim();
  if (!path) {
    return '';
  }
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const base = (baseUrl ?? '').replace(/\/+$/, '');
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

/** 展示用标题，例如「发现新版本 0.2.0」。 */
export function updateTitle(release: AppRelease): string {
  const name = (release.versionName ?? '').trim() || String(versionCodeOf(release));
  return `发现新版本 ${name}`;
}

/** 更新说明拼成一段文本；没有说明时给一句兜底文案（不留空，否则弹窗看着像坏了）。 */
export function updateChangelog(release: AppRelease): string {
  const items = (release.changelog ?? []).map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) {
    return '本次更新包含功能改进与问题修复。';
  }
  return items.map((item) => `· ${item}`).join('\n');
}

/** 字节数转成人话（「约 75 MB」）；没配就返回 null，界面上不显示这一行。 */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) {
    return `约 ${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  return `约 ${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 「强制更新」的原因文案：说清楚为什么不让跳过，用户才不会以为遇上了 bug。
 */
export function forceReasonText(decision: Extract<UpdateDecision, { kind: 'force' }>): string {
  return decision.reason === 'unsupported'
    ? '当前版本太旧，服务器已不再支持，需要更新后才能继续使用。'
    : '这是一次必须完成的更新。';
}
