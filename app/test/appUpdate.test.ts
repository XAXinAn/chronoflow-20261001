import { describe, expect, it } from 'vitest';

import type { AppRelease } from '../src/api/appRelease';
import {
  decideUpdate,
  formatBytes,
  forceReasonText,
  resolveApkUrl,
  updateChangelog,
  updateTitle,
} from '../src/domain/appUpdate';

/**
 * 应用内更新的判定（spec §4.1.11）。
 *
 * 这些边界值得钉死：判错一次的最坏后果是**全员被强制更新页挡住**，
 * 或者**谁都收不到更新**。所以「没配置 = 不打扰」这条要反复验。
 */

const release: AppRelease = {
  versionName: '0.2.0',
  versionCode: 2,
  apkUrl: '/downloads/app-0.2.0.apk',
  sizeBytes: 78_643_200,
  changelog: ['图片识别日程', '修复重复日程'],
};

describe('要不要更新', () => {
  it('线上版本更高 → 可选更新', () => {
    expect(decideUpdate(1, release)).toEqual({ kind: 'optional', release });
  });

  it('已经是最新（或更新）→ 什么都不弹', () => {
    expect(decideUpdate(2, release).kind).toBe('none');
    expect(decideUpdate(9, release).kind).toBe('none');
  });

  it('没配置发布信息 → 当没有更新，绝不能编一个出来', () => {
    expect(decideUpdate(1, null).kind).toBe('none');
    expect(decideUpdate(1, undefined).kind).toBe('none');
    expect(decideUpdate(1, { versionCode: 0, apkUrl: '/x.apk' }).kind).toBe('none');
    // 只配了版本号、没配包地址：同样当作没配置（否则会去下载一个空地址）
    expect(decideUpdate(1, { versionCode: 5 }).kind).toBe('none');
    expect(decideUpdate(1, { versionCode: 5, apkUrl: '   ' }).kind).toBe('none');
  });

  it('读不到本地版本号（0）→ 不打扰用户', () => {
    // Expo Go / Web / 原生版本读不到时不弹窗，更不强制——那种环境本来也装不了 APK
    expect(decideUpdate(0, release).kind).toBe('none');
    expect(decideUpdate(Number.NaN, release).kind).toBe('none');
  });

  it('发布方标了强制 → 强制更新，不给「稍后」', () => {
    const forced = { ...release, force: true };
    expect(decideUpdate(1, forced)).toEqual({ kind: 'force', release: forced, reason: 'force' });
  });

  it('本地版本低于服务端支持下限 → 也是强制更新，但文案要说清原因', () => {
    const decision = decideUpdate(1, { ...release, minSupportedVersionCode: 2 });
    expect(decision).toEqual({
      kind: 'force',
      release: { ...release, minSupportedVersionCode: 2 },
      reason: 'unsupported',
    });
    expect(forceReasonText(decision as Extract<typeof decision, { kind: 'force' }>))
      .toContain('服务器已不再支持');
  });
});

describe('界面上的文案与地址', () => {
  it('安装包地址：绝对 URL 原样用，相对路径拼当前 API 域名', () => {
    expect(resolveApkUrl('/downloads/a.apk', 'http://8.136.20.182:8088')).toBe(
      'http://8.136.20.182:8088/downloads/a.apk',
    );
    expect(resolveApkUrl('downloads/a.apk', 'http://x:8088/')).toBe('http://x:8088/downloads/a.apk');
    expect(resolveApkUrl('https://cdn.example.com/a.apk', 'http://x:8088')).toBe(
      'https://cdn.example.com/a.apk',
    );
    expect(resolveApkUrl('', 'http://x:8088')).toBe('');
  });

  it('标题与更新说明', () => {
    expect(updateTitle(release)).toBe('发现新版本 0.2.0');
    expect(updateChangelog(release)).toBe('· 图片识别日程\n· 修复重复日程');
    // 没写说明时给一句兜底：空白弹窗看起来像界面坏了
    expect(updateChangelog({ ...release, changelog: [] })).toContain('功能改进与问题修复');
  });

  it('安装包大小：说人话，没配就不显示', () => {
    expect(formatBytes(78_643_200)).toBe('约 75 MB');
    expect(formatBytes(500 * 1024)).toBe('约 500 KB');
    expect(formatBytes(0)).toBeNull();
    expect(formatBytes(null)).toBeNull();
  });
});
