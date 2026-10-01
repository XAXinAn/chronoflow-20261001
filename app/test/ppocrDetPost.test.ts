import { describe, expect, it } from 'vitest';

import {
  binarize,
  clampRect,
  connectedComponents,
  filterBoxes,
  mapBoxToImage,
  orderBoxes,
  planDetInput,
  unclipRect,
} from '../src/vision/ppocr/detPost';

/** 用矩形在 10×10 的概率图上画「一块字」。 */
function paint(
  rect: { x: number; y: number; width: number; height: number },
  value: number,
  size = 10,
  base = 0.01,
): Float32Array {
  const out = new Float32Array(size * size).fill(base);
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      out[y * size + x] = value;
    }
  }
  return out;
}

describe('DB 检测后处理', () => {
  it('检测输入规划：等比缩到最长边 + 补边到 32 的倍数', () => {
    const plan = planDetInput(1920, 1080, 960, 32);
    expect(plan.scale).toBeCloseTo(0.5);
    expect(plan.scaledWidth).toBe(960);
    expect(plan.scaledHeight).toBe(540);
    expect(plan.inputWidth).toBe(960);
    expect(plan.inputHeight).toBe(544); // 540 → 补到 544
    expect(plan.padX).toBe(0);
    expect(plan.padY).toBe(2);

    // 小图不放大（宁可保持原尺寸，也不要把噪声放大成字）
    const small = planDetInput(320, 200, 960, 32);
    expect(small.scale).toBe(1);
    expect(small.scaledWidth).toBe(320);
    expect(small.scaledHeight).toBe(200);
    expect(small.inputWidth).toBe(320);
    expect(small.inputHeight).toBe(224);
  });

  it('夹取坐标：探出边界的框要夹回来，起点取整、长宽至少 1', () => {
    const bounds = { width: 100, height: 50 };
    // 左上探出去（外扩的常见结果）：起点变 0、右下角不变
    expect(clampRect({ x: -8.4, y: -3.2, width: 40, height: 20 }, bounds))
      .toEqual({ x: 0, y: 0, width: 40, height: 20 });
    // 右下探出去：宽度收到边界（100 - 20），起点带小数要向下取整
    expect(clampRect({ x: 20.7, y: 10.9, width: 200, height: 200 }, bounds))
      .toEqual({ x: 20, y: 10, width: 80, height: 40 });
    // 起点已经贴在右下角：也不能给出 0 宽 / 0 高（裁剪器不接受空框）
    const pinned = clampRect({ x: 100, y: 50, width: 10, height: 10 }, bounds);
    expect(pinned.width).toBe(1);
    expect(pinned.height).toBe(1);
  });

  it('二值化 + 连通域：两块分开的字各成一个框，边界对得上', () => {
    const scores = paint({ x: 1, y: 1, width: 3, height: 2 }, 0.9);
    // 第二块画在 (6,6)-(8,8)
    for (let y = 6; y <= 8; y += 1) {
      for (let x = 6; x <= 8; x += 1) {
        scores[y * 10 + x] = 0.8;
      }
    }
    const mask = binarize(scores, 10, 10);
    const boxes = connectedComponents(mask, scores, 10, 10);

    expect(boxes).toHaveLength(2);
    // 排序只关心位置，但这里还要断分数，所以按顺序取回原始对象（带 score）
    const [first, second] = orderBoxes(boxes).map(
      (ordered) => boxes.find((box) => box.x === ordered.x && box.y === ordered.y)!,
    );
    expect(first).toMatchObject({ x: 1, y: 1, width: 3, height: 2 });
    expect(second).toMatchObject({ x: 6, y: 6, width: 3, height: 3 });
    expect(first!.score).toBeCloseTo(0.9, 2);
    expect(second!.score).toBeCloseTo(0.8, 2);
  });

  it('低于阈值的块不进掩码；平均分低的块被过滤掉', () => {
    const scores = paint({ x: 0, y: 0, width: 4, height: 4 }, 0.4); // 过二值化阈值但平均分低
    const boxes = connectedComponents(binarize(scores, 10, 10), scores, 10, 10);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.score).toBeCloseTo(0.4, 2);
    expect(filterBoxes(boxes)).toHaveLength(0);

    // 太小的块（2×2）也是噪声
    const tiny = paint({ x: 2, y: 2, width: 2, height: 2 }, 0.9);
    const tinyBoxes = connectedComponents(binarize(tiny, 10, 10), tiny, 10, 10);
    expect(filterBoxes(tinyBoxes)).toHaveLength(0);
  });

  it('unclip 外扩：DB 的框比文字小一圈，不外扩会缺首尾字', () => {
    const expanded = unclipRect({ x: 10, y: 10, width: 100, height: 20 }, 1.5);
    // distance = 100*20*1.5 / (2*120) = 12.5
    expect(expanded.x).toBeCloseTo(-2.5);
    expect(expanded.y).toBeCloseTo(-2.5);
    expect(expanded.width).toBeCloseTo(125);
    expect(expanded.height).toBeCloseTo(45);

    // 给了边界就夹回去，且长宽始终 > 0（裁剪器不接受空框）
    const clamped = unclipRect({ x: 0, y: 0, width: 8, height: 8 }, 1.5, { width: 10, height: 10 });
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
    expect(clamped.width).toBeGreaterThan(0);
    expect(clamped.height).toBeGreaterThan(0);
    expect(clamped.width).toBeLessThanOrEqual(10);
  });

  it('框映射回原图：减补边、再除以缩放（正反算得回来）', () => {
    const plan = planDetInput(1920, 1080, 960, 32);
    const mapped = mapBoxToImage({ x: 100, y: 102, width: 200, height: 40 }, plan);
    expect(mapped.x).toBeCloseTo(200);
    expect(mapped.y).toBeCloseTo(200); // (102 - 2) / 0.5
    expect(mapped.width).toBeCloseTo(400);
    expect(mapped.height).toBeCloseTo(80);
  });

  it('阅读顺序：先上后下，同一行内先左后右', () => {
    const ordered = orderBoxes([
      { x: 200, y: 100, width: 50, height: 20 }, // 第一行右
      { x: 10, y: 300, width: 50, height: 20 },  // 第二行
      { x: 20, y: 104, width: 50, height: 20 },  // 第一行左（中心差 4 < 10）
    ]);
    expect(ordered.map((box) => box.x)).toEqual([20, 200, 10]);
  });
});
