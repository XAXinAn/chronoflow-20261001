/**
 * 「应用内更新」的发布信息（spec §4.1.11，`GET /system/app-release`，免登录）。
 *
 * <p>服务端**没有配置发布信息**时只回 `versionCode: 0`，其余字段缺失或为 null——
 * 客户端必须把这种情况当成「这个部署不提供更新」，而不是当成「有新版本」。
 */
export interface AppRelease {
  /** 展示用版本名，如 0.2.0 */
  versionName?: string | null;
  /** 整数版本号；`<= 0` 表示没有发布信息 */
  versionCode?: number | null;
  /** 安装包地址：绝对 URL，或以 `/` 开头的相对路径（客户端拼当前 API 域名） */
  apkUrl?: string | null;
  /** 安装包字节数；0 / 缺失 = 没配 */
  sizeBytes?: number | null;
  /** 安装包 SHA-256；缺失 = 不校验 */
  sha256?: string | null;
  /** 更新说明（服务端按 `|` 拆好的多条） */
  changelog?: string[] | null;
  /** 强制更新：客户端不给「稍后」 */
  force?: boolean | null;
  /** 低于这个版本号的客户端必须更新；0 = 不限制 */
  minSupportedVersionCode?: number | null;
  /** 发布时间，ISO-8601；没配就是 null */
  publishedAt?: string | null;
}
