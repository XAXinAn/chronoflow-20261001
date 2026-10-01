import { describe, expect, it } from 'vitest';

import {
  MAX_AVATAR_ZOOM,
  clampTransform,
  coverScale,
  cropRect,
  initialTransform,
  renderedSize,
  scaleFromPinch,
  touchDistance,
} from '../src/domain/avatarCrop';

/** 4:3 横图，取景框 300 —— 最常见的「不是 1:1」情况。 */
const LANDSCAPE = { width: 400, height: 300 };
/** 竖图（手机直接拍的照片）。 */
const PORTRAIT = { width: 300, height: 400 };
const VIEWPORT = 300;

/**
 * 图片是否仍然盖满取景框（不露白）——这是整套几何唯一不能破的约束。
 *
 * 图片中心在取景框中心 + offset 处，所以左右边界分别是
 * `(viewport - width) / 2 + offsetX` 与 `+ width`。
 */
function viewportCovered(
  size: { width: number; height: number },
  offsetX: number,
  offsetY = 0,
  viewport = VIEWPORT,
): boolean {
  return (
    (viewport - size.width) / 2 + offsetX <= 0.001
    && (viewport + size.width) / 2 + offsetX >= viewport - 0.001
    && (viewport - size.height) / 2 + offsetY <= 0.001
    && (viewport + size.height) / 2 + offsetY >= viewport - 0.001
  );
}

describe('头像裁剪的几何', () => {
  it('铺满取景框：横图按宽、竖图按高，短边被放大到刚好盖住', () => {
    // 400×300 的横图放进 300 的方框：按高算需要 1 倍（300/300），此时宽 400 溢出
    expect(coverScale(LANDSCAPE, VIEWPORT)).toBeCloseTo(1);
    // 竖图反过来：按高算 0.75 不够盖住宽，所以取 1 倍
    expect(coverScale(PORTRAIT, VIEWPORT)).toBeCloseTo(1);
    const landscape = renderedSize(LANDSCAPE, VIEWPORT, initialTransform(LANDSCAPE, VIEWPORT));
    expect(landscape.width).toBeCloseTo(400);
    expect(landscape.height).toBeCloseTo(300);
    const portrait = renderedSize(PORTRAIT, VIEWPORT, initialTransform(PORTRAIT, VIEWPORT));
    expect(portrait.width).toBeCloseTo(300);
    expect(portrait.height).toBeCloseTo(400); // 高溢出
  });

  it('初始摆放是居中：裁剪矩形落在图片正中间，且是正方形', () => {
    const rect = cropRect(LANDSCAPE, VIEWPORT, initialTransform(LANDSCAPE, VIEWPORT));
    // 横图 400×300 铺满后宽溢出，取中间 300（=400×0.75）那块
    expect(rect.originX).toBeCloseTo(50);
    expect(rect.originY).toBeCloseTo(0);
    expect(rect.width).toBeCloseTo(300);
    expect(rect.height).toBeCloseTo(300);
  });

  it('拖到边上不会露白：位移被夹在图片边缘', () => {
    const dragged = clampTransform(LANDSCAPE, VIEWPORT, {
      scale: 1,
      offsetX: 9999,
      offsetY: 9999,
    });
    // 400×300 的图铺满 300 方框后：横向有 (400-300)/2 = 50 的余量，纵向刚好没有
    expect(dragged.offsetX).toBeCloseTo(50);
    expect(dragged.offsetY).toBeCloseTo(0);

    // 放大到 2 倍之后就有余量可拖了
    const zoomed = clampTransform(LANDSCAPE, VIEWPORT, { scale: 2, offsetX: 9999, offsetY: -9999 });
    expect(zoomed.offsetX).toBeCloseTo((400 * 2 - 300) / 2);
    expect(zoomed.offsetY).toBeCloseTo(-((300 * 2 - 300) / 2));
  });

  it('缩回 1 倍时位移被收回可用范围（露白才是 bug，不是「必须回到 0」）', () => {
    const zoomedIn = clampTransform(PORTRAIT, VIEWPORT, { scale: 3, offsetX: 0, offsetY: 400 });
    expect(zoomedIn.offsetY).toBeCloseTo(400); // 3 倍时纵向余量 (1200-300)/2 = 450
    const backToOne = clampTransform(PORTRAIT, VIEWPORT, { ...zoomedIn, scale: 1 });
    // 1 倍时纵向只剩 (400-300)/2 = 50 的余量，多出来的必须收掉，否则下边会露白
    expect(backToOne.offsetY).toBeCloseTo(50);
    const size = renderedSize(PORTRAIT, VIEWPORT, backToOne);
    expect(viewportCovered(size, backToOne.offsetX, backToOne.offsetY)).toBe(true);
  });

  it('缩放夹在 1..4 之间', () => {
    expect(clampTransform(LANDSCAPE, VIEWPORT, { scale: 0.2, offsetX: 0, offsetY: 0 }).scale).toBe(1);
    expect(clampTransform(LANDSCAPE, VIEWPORT, { scale: 99, offsetX: 0, offsetY: 0 }).scale)
      .toBe(MAX_AVATAR_ZOOM);
    expect(scaleFromPinch(1, 100, 1000)).toBe(MAX_AVATAR_ZOOM);
    expect(scaleFromPinch(1, 100, 10)).toBe(1);
    expect(scaleFromPinch(2, 0, 50)).toBe(2); // 起始距离为 0（单指）时不动
  });

  it('放大后拖到左上角：裁剪矩形贴住原图左上角，且不越界', () => {
    // 2 倍 + 拖到极限：取景框该看到原图的左上角那块
    const t = clampTransform(LANDSCAPE, VIEWPORT, { scale: 2, offsetX: 9999, offsetY: 9999 });
    const rect = cropRect(LANDSCAPE, VIEWPORT, t);
    expect(rect.originX).toBeCloseTo(0);
    expect(rect.originY).toBeCloseTo(0);
    // 2 倍下取景框只覆盖原图宽度的 300/(400×2) = 37.5% → 150 像素
    expect(rect.width).toBeCloseTo(150);
    expect(rect.height).toBeCloseTo(150);
  });

  it('裁剪矩形永远在原图范围内（亚像素也不越界）', () => {
    for (const image of [LANDSCAPE, PORTRAIT, { width: 1000, height: 999 }]) {
      for (const scale of [1, 1.37, 2.5, MAX_AVATAR_ZOOM]) {
        for (const offsetX of [-5000, -13, 0, 13, 5000]) {
          for (const offsetY of [-5000, -13, 0, 13, 5000]) {
            const rect = cropRect(image, VIEWPORT, { scale, offsetX, offsetY });
            expect(rect.originX).toBeGreaterThanOrEqual(0);
            expect(rect.originY).toBeGreaterThanOrEqual(0);
            expect(rect.width).toBeGreaterThan(0);
            expect(rect.height).toBeGreaterThan(0);
            expect(rect.originX + rect.width).toBeLessThanOrEqual(image.width + 0.001);
            expect(rect.originY + rect.height).toBeLessThanOrEqual(image.height + 0.001);
          }
        }
      }
    }
  });

  it('两指距离：水平或垂直都算，位置重合时为 0', () => {
    expect(touchDistance({ pageX: 0, pageY: 0 }, { pageX: 3, pageY: 4 })).toBeCloseTo(5);
    expect(touchDistance({ pageX: 10, pageY: 10 }, { pageX: 10, pageY: 10 })).toBe(0);
  });
});
