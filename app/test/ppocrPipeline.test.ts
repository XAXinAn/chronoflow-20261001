import { describe, expect, it } from 'vitest';

import { MIN_LINE_CONFIDENCE } from '../src/vision/ppocr/decode';
import { REC_MEAN, REC_STD, type RgbaImage } from '../src/vision/ppocr/pixels';
import {
  MAX_LINES,
  REC_HEIGHT,
  recognizeLines,
  type OcrImageSource,
  type OcrSession,
  type RecOutput,
} from '../src/vision/ppocr/pipeline';
import type { Rect } from '../src/vision/ppocr/detPost';

/**
 * 端到端（假 session、假取像素）：**检测 → 后处理 → 裁剪 → 识别 → 解码 → 阅读顺序**。
 *
 * <p>真机上这条链路只能靠「识别得对不对」间接判断，所以这里把它拆开验：假 session 按
 * 约定返回概率图 / 得分矩阵，假取像素把「裁的是哪一块」编进像素值里（见 {@link spot}），
 * 于是「框切偏了」「顺序乱了」「通道顺序反了」都能当场看出来。
 */

/** 测试用字符表：下标 0 是 blank，1/2/3 依次是 甲/乙/丙。 */
const CHARS = ['', '甲', '乙', '丙'];

/** 原图尺寸（检测输入会被补到 320×224，见 planDetInput 的算法）。 */
const IMAGE = { width: 320, height: 200 };
const URI = 'file:///tmp/notice.jpg';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一块纯黑图，只有左上角一个像素是亮的——用来判断「这块被没被转 180°」。 */
function spot(width: number, height: number, marker: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  data[0] = marker;
  data[1] = marker;
  data[2] = marker;
  data[3] = 255;
  for (let i = 1; i < width * height; i += 1) {
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function black(width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** 检测概率图：0.01 的底 + 指定位置的文字块（分数 0.9）。 */
function paint(width: number, height: number, boxes: Box[]): Float32Array {
  const scores = new Float32Array(width * height).fill(0.01);
  for (const box of boxes) {
    for (let y = box.y; y < box.y + box.height; y += 1) {
      for (let x = box.x; x < box.x + box.width; x += 1) {
        scores[y * width + x] = 0.9;
      }
    }
  }
  return scores;
}

/** 某一帧命中的「类别 → 得分」矩阵，其余类给 0.05。 */
function recScores(frames: number[], hit = 0.9): { scores: Float32Array; timesteps: number; classes: number } {
  const classes = CHARS.length;
  const scores = new Float32Array(frames.length * classes).fill(0.05);
  frames.forEach((index, t) => {
    scores[t * classes + index] = hit;
  });
  return { scores, timesteps: frames.length, classes };
}

/** 像素值 → 亮点的标记（`toChwTensor` 的逆算：灰度三通道取值都一样，所以读第 0 个平面就够）。 */
function markerOf(tensor: Float32Array, index: number): number {
  return Math.round((((tensor[index] ?? 0) * REC_STD[0]) + REC_MEAN[0]) * 255);
}

interface HarnessOptions {
  /** 检测输出的文字块（检测输入图坐标系） */
  boxes: Box[];
  /** 分类头给出的判定；不给就不注册分类（流水线会跳过这一步） */
  classify?: (marker: number) => boolean;
  /** 命中类别的得分，用来构造「认不准」的行 */
  hitScore?: number;
}

function harness(options: HarnessOptions) {
  const crops: Rect[] = [];
  const recSizes: { width: number; height: number }[] = [];
  const classifyCalls: number[] = [];

  const image: OcrImageSource = {
    size: async () => ({ ...IMAGE }),
    scaled: async (_uri, width, height) => black(width, height),
    cropped: async (_uri, region, width, height) => {
      crops.push(region);
      recSizes.push({ width, height });
      // 第一行（原图 y<20）标记 1、其余标记 2：识别头据此吐出不同的字
      return spot(width, height, region.y < 20 ? 1 : 2);
    },
  };

  const session: OcrSession = {
    detect: async (_tensor, width, height) => ({
      scores: paint(width, height, options.boxes),
      width,
      height,
    }),
    recognize: async (tensor, width, height): Promise<RecOutput> => {
      const topLeft = markerOf(tensor, 0);
      // 被转过 180° 的那块，亮点跑到了右下角（最后一个像素）
      const bottomRight = markerOf(tensor, width * height - 1);
      // 亮点还在左上 = 没转过（标记几就是第几行）；跑到右下 = 被转过 180°
      const classIndex = topLeft > 0 ? topLeft : 3;
      if (topLeft === 0 && bottomRight === 0) {
        throw new Error('裁剪出来的那块是空的');
      }
      return recScores([classIndex], options.hitScore);
    },
    ...(options.classify
      ? {
        classify: async (tensor) => {
          const marker = markerOf(tensor, 0);
          classifyCalls.push(marker);
          return { rotated: options.classify!(marker), score: 0.99 };
        },
      }
      : {}),
  };

  return { image, session, crops, recSizes, classifyCalls };
}

describe('PP-OCR 流水线', () => {
  it('两块文字 → 两行，坐标（外扩 + 去补边 + 夹边界）与阅读顺序都对', async () => {
    const { image, session, crops, recSizes } = harness({
      boxes: [
        { x: 10, y: 20, width: 80, height: 24 }, // 第一行
        { x: 10, y: 60, width: 80, height: 24 }, // 第二行
      ],
    });

    const lines = await recognizeLines(URI, { image, session, characters: CHARS });

    expect(lines.map((line) => line.text)).toEqual(['甲', '乙']);
    // 检测输入是 320×224（200 补到 32 的倍数 → padY = 12）
    // 外扩距离 = 80×24×1.5 / (2×(80+24)) ≈ 13.85：
    //   第一行 y=20 → 6.15 → 减补边 12 → -5.85 → 夹到 0，高 ≈ 51.7 → 52
    //   第二行 y=60 → 46.15 → 减补边 12 → 34.15 → 34
    expect(crops[0]).toEqual({ x: 0, y: 0, width: 108, height: 52 });
    expect(crops[1]).toEqual({ x: 0, y: 34, width: 108, height: 52 });
    // 识别输入固定高 48、宽按比例（108×48/52 ≈ 100）
    expect(recSizes[0]).toEqual({ width: 100, height: REC_HEIGHT });
  });

  it('方向分类判为倒置时，把裁剪出的像素转 180° 再识别', async () => {
    const { image, session, classifyCalls } = harness({
      boxes: [{ x: 10, y: 20, width: 80, height: 24 }],
      // 第一行（标记 1）判为倒着
      classify: (marker) => marker === 1,
    });

    const lines = await recognizeLines(URI, { image, session, characters: CHARS });

    expect(classifyCalls).toEqual([1]); // 分类头确实被调了
    expect(lines).toHaveLength(1);
    expect(lines[0]!.rotated).toBe(true);
    // 转过之后左上角的亮点跑到右下角，识别头读到的就是「转过的那一块」
    expect(lines[0]!.text).toBe('丙');
  });

  it('认不准的行（置信度低于阈值）整行丢掉，不硬写进结果', async () => {
    const { image, session } = harness({
      boxes: [{ x: 10, y: 20, width: 80, height: 24 }],
      hitScore: MIN_LINE_CONFIDENCE - 0.2,
    });

    const lines = await recognizeLines(URI, { image, session, characters: CHARS });
    expect(lines).toEqual([]);
  });

  it('一个框都没有时返回空数组（不是抛错）', async () => {
    const { image, session } = harness({ boxes: [] });
    await expect(recognizeLines(URI, { image, session, characters: CHARS })).resolves.toEqual([]);
  });

  it('行数有上限：一片密密麻麻的文字也只识别前 MAX_LINES 行', async () => {
    const boxes: Box[] = [];
    for (let row = 0; row < 12; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        boxes.push({ x: 10 + column * 60, y: 6 + row * 18, width: 20, height: 4 });
      }
    }
    const { image, session, crops } = harness({ boxes });

    const lines = await recognizeLines(URI, { image, session, characters: CHARS });

    expect(boxes).toHaveLength(60);
    expect(lines).toHaveLength(MAX_LINES);
    expect(crops).toHaveLength(MAX_LINES); // 多余的框根本不去裁剪
    // 留下的必须是按阅读顺序排在最前面的那些：y 单调不减
    const ys = lines.map((line) => line.box.y);
    expect([...ys].sort((left, right) => left - right)).toEqual(ys);
  });

  it('检测输出与声明的形状对不上时抛错（而不是默默识别出错字）', async () => {
    const { image, session } = harness({ boxes: [] });
    const broken: OcrSession = {
      ...session,
      detect: async () => ({ scores: new Float32Array(4), width: 10, height: 10 }),
    };
    await expect(recognizeLines(URI, { image, session: broken, characters: CHARS }))
      .rejects.toThrow(/检测输出对不上/);
  });
});
