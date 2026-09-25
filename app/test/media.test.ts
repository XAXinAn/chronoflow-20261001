import { describe, expect, it } from 'vitest';

import { absoluteMediaUrl } from '../src/domain/media';

/**
 * 服务端存相对 URL（换域名/CDN 不用改数据），展示时由这里拼出完整地址。
 * 拼错的症状是「头像上传成功但一直是空的」，所以把边界都钉住。
 */
describe('媒体地址（spec §4.1.8 / §5.10）', () => {
  it('相对 URL 拼上 API 地址', () => {
    expect(absoluteMediaUrl('http://10.0.2.2:8080', '/uploads/ab12.jpg')).toBe(
      'http://10.0.2.2:8080/uploads/ab12.jpg',
    );
    // 结尾多一个斜杠也不能拼出双斜杠
    expect(absoluteMediaUrl('http://10.0.2.2:8080/', '/uploads/ab12.jpg')).toBe(
      'http://10.0.2.2:8080/uploads/ab12.jpg',
    );
    // 服务端万一没给前导斜杠，也要拼对
    expect(absoluteMediaUrl('http://10.0.2.2:8080', 'uploads/ab12.jpg')).toBe(
      'http://10.0.2.2:8080/uploads/ab12.jpg',
    );
  });

  it('已经是绝对地址就原样使用（将来换成对象存储/CDN 时不用改代码）', () => {
    expect(absoluteMediaUrl('http://10.0.2.2:8080', 'https://cdn.example.com/a.jpg')).toBe(
      'https://cdn.example.com/a.jpg',
    );
  });

  it('没有头像时返回 null，交给调用方决定展示什么', () => {
    expect(absoluteMediaUrl('http://10.0.2.2:8080', null)).toBeNull();
    expect(absoluteMediaUrl('http://10.0.2.2:8080', undefined)).toBeNull();
    expect(absoluteMediaUrl('http://10.0.2.2:8080', '')).toBeNull();
  });
});
