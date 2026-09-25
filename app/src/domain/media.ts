/**
 * 媒体地址（spec §4.1.8 / §5.10）。
 *
 * 服务端存的是**相对 URL**（`/uploads/ab12….jpg`），这样换域名、上 CDN 都不用改数据。
 * 代价是展示时必须在这里拼上当前 API 地址——拼错就会「头像上传成功但一直是空的」。
 */
export function absoluteMediaUrl(baseUrl: string, url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  // 已经是绝对地址（将来换成对象存储/CDN 时会出现）就原样用
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return url;
  }
  const base = baseUrl.replace(/\/+$/, '');
  return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`;
}
