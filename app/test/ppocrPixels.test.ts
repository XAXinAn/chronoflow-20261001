import { describe, expect, it } from 'vitest';
import { encode as encodeJpeg } from 'jpeg-js';

import {
  DET_MEAN,
  DET_STD,
  REC_MEAN,
  REC_STD,
  base64ToBytes,
  decodeJpegBytes,
  padToCanvas,
  rotate180,
  resizeNearest,
  toChwTensor,
} from '../src/vision/ppocr/pixels';

/** 2×2 的测试图：左上红、右上绿、左下蓝、右下白。 */
function sample(): { width: number; height: number; data: Uint8Array } {
  return {
    width: 2,
    height: 2,
    data: new Uint8Array([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 255, 255,
    ]),
  };
}

describe('端侧 OCR 的取像素', () => {
  it('base64 解码：长度、边界与非法字符容错', () => {
    expect([...base64ToBytes('AAAA')]).toEqual([0, 0, 0]);
    expect([...base64ToBytes('////')]).toEqual([255, 255, 255]);
    // 换行、前缀（data:image/jpeg;base64,）这类噪声要被忽略
    expect([...base64ToBytes('AA\nAA')]).toEqual([0, 0, 0]);
    expect([...base64ToBytes('data:image/jpeg;base64,AAAA')].length).toBeGreaterThan(0);
    expect(base64ToBytes('').length).toBe(0);
  });

  it('JPEG 解码往返：编码进去的像素还能读回来（真图走同一条路径）', () => {
    // 2×2 太小：JPEG 的色度是 4:2:0 下采样的，2×2 里四个像素会互相串色。
    // 用 8×8（左半红、右半蓝）才测得到「通道没串、没整体位移」。
    const width = 8;
    const data = new Uint8Array(width * width * 4);
    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        const red = x < width / 2;
        data[at] = red ? 255 : 0;
        data[at + 1] = 0;
        data[at + 2] = red ? 0 : 255;
        data[at + 3] = 255;
      }
    }
    const jpeg = encodeJpeg({ width, height: width, data }, 100);
    const decoded = decodeJpegBytes(new Uint8Array(jpeg.data));
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(width);
    // 左边偏红、右边偏蓝（JPEG 有损，只看通道倾向，不比精确值）
    const left = (width / 2 + 0) * 0;
    expect(decoded.data[left]).toBeGreaterThan(180);
    expect(decoded.data[left + 2]).toBeLessThan(80);
    const right = (0 * width + (width - 1)) * 4;
    expect(decoded.data[right + 2]).toBeGreaterThan(180);
    expect(decoded.data[right]).toBeLessThan(80);
  });

  it('最近邻缩放：放大后每个像素都被复制，不插值出新的颜色', () => {
    const resized = resizeNearest(sample(), 4, 4);
    expect(resized.width).toBe(4);
    // 2 宽的图放大到 4 宽：x=0,1 取源列 0，x=2,3 取源列 1
    expect([...resized.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...resized.data.slice(12, 16)]).toEqual([0, 255, 0, 255]); // 右上那块被复制两列
    expect([...resized.data.slice(60, 64)]).toEqual([255, 255, 255, 255]); // 右下
  });

  it('补边到画布：补的区域是纯黑（DB 在纯黑上不会凭空造框）', () => {
    const padded = padToCanvas(sample(), 4, 2, 0, 0);
    expect(padded.width).toBe(4);
    // 第 0 行后两个像素是补出来的
    expect([...padded.data.slice(8, 12)]).toEqual([0, 0, 0, 0]);
    // 第 1 行前两个像素还是原来的左下蓝
    expect([...padded.data.slice(16, 20)]).toEqual([0, 0, 255, 255]);
  });

  it('NCHW 张量：RGB 顺序正确、按 ImageNet 参数归一化', () => {
    const tensor = toChwTensor(sample(), DET_MEAN, DET_STD);
    expect(tensor.length).toBe(3 * 2 * 2);
    const plane = 4;
    // 左上角是红：R 通道高、G 通道低
    expect(tensor[0]).toBeCloseTo((1 - DET_MEAN[0]) / DET_STD[0], 4);
    expect(tensor[plane + 0]).toBeCloseTo((0 - DET_MEAN[1]) / DET_STD[1], 4);
    expect(tensor[plane * 2 + 0]).toBeCloseTo((0 - DET_MEAN[2]) / DET_STD[2], 4);
    // 识别头的 0.5/0.5：白 = +1，黑 = -1
    const white = { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) };
    expect(toChwTensor(white, REC_MEAN, REC_STD)[0]).toBeCloseTo(1, 4);
    const black = { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) };
    expect(toChwTensor(black, REC_MEAN, REC_STD)[0]).toBeCloseTo(-1, 4);
  });

  it('通道顺序：识别头要 BGR，别照抄检测头那套 RGB（搞反了不报错、只是掉识别率）', () => {
    const plane = 4;
    const rgb = toChwTensor(sample(), REC_MEAN, REC_STD, 'rgb');
    const bgr = toChwTensor(sample(), REC_MEAN, REC_STD, 'bgr');
    // 左上角是纯红：RGB 下第 0 个平面是 1（白），BGR 下是 -1（黑）
    expect(rgb[0]).toBeCloseTo(1, 4);
    expect(bgr[0]).toBeCloseTo(-1, 4);
    // 第 2 个平面正好相反
    expect(rgb[plane * 2]).toBeCloseTo(-1, 4);
    expect(bgr[plane * 2]).toBeCloseTo(1, 4);
    // 绿通道在哪个顺序下都不动
    expect(rgb[plane]).toBeCloseTo(bgr[plane]!, 6);
    // 默认是 RGB（不传 order 时不能悄悄变成 BGR）
    expect([...toChwTensor(sample(), REC_MEAN, REC_STD)]).toEqual([...rgb]);
  });

  it('旋转 180°：像素对角互换（倒着的文字转正要用它）', () => {
    const rotated = rotate180(sample());
    expect(rotated.width).toBe(2);
    expect(rotated.height).toBe(2);
    // 原图：左上红 / 右上绿 / 左下蓝 / 右下白 → 转完正好反过来
    expect([...rotated.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...rotated.data.slice(4, 8)]).toEqual([0, 0, 255, 255]);
    expect([...rotated.data.slice(8, 12)]).toEqual([0, 255, 0, 255]);
    expect([...rotated.data.slice(12, 16)]).toEqual([255, 0, 0, 255]);
    // 转两次回到原样
    expect([...rotate180(rotated).data]).toEqual([...sample().data]);
    // 原图不被改（纯函数）
    expect([...rotate180(rotated).data]).toEqual([...sample().data]);
  });
});
