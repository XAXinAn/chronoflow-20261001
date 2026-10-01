import { describe, expect, it } from 'vitest';

import { decodeCtc, parseCharacterList } from '../src/vision/ppocr/decode';

/** 测试用的小字符表：下标 0 是 blank，后面依次是 a b c。 */
const CHARS = ['', 'a', 'b', 'c'];
const CLASSES = CHARS.length;

/** 把「每帧下标」铺成 onnxruntime 那种 [T, C] 得分矩阵（命中项 0.9，其余 0.1）。 */
function scores(frames: number[]): Float32Array {
  const out = new Float32Array(frames.length * CLASSES).fill(0.1);
  frames.forEach((index, t) => {
    out[t * CLASSES + index] = 0.9;
  });
  return out;
}

function decode(frames: number[]) {
  return decodeCtc(scores(frames), frames.length, CLASSES, CHARS);
}

describe('PP-OCR 的 CTC 解码', () => {
  it('基本解码：跳 blank、跳过空帧', () => {
    expect(decode([0, 1, 0, 2, 0]).text).toBe('ab');
    expect(decode([0, 0, 0]).text).toBe('');
  });

  it('连续重复合并：同一帧连着出现只算一个字', () => {
    expect(decode([1, 1, 1, 0]).text).toBe('a');
    expect(decode([1, 1, 2, 2]).text).toBe('ab');
  });

  it('「a·blank·a」是两个 a（先合并重复、再丢 blank 才是对的顺序）', () => {
    // 顺序写反（先去 blank 再合并）会得到 'a'，叠字就丢了
    expect(decode([1, 0, 1]).text).toBe('aa');
    expect(decode([1, 0, 1, 0, 1]).text).toBe('aaa');
  });

  it('置信度是保留字符的平均得分', () => {
    expect(decode([1, 2]).confidence).toBeCloseTo(0.9);
    // 什么都没解出来时是 0，而不是 1（别让空行看起来「很确定」）
    expect(decode([0, 0]).confidence).toBe(0);
  });

  it('字符表比模型短时不写出 undefined（元数据缺失的兜底）', () => {
    const short = ['', 'a'];
    const result = decodeCtc(scores([1, 2, 3]), 3, CLASSES, short);
    expect(result.text).toBe('a');
  });

  it('模型元数据的字符表：换行分隔，前面补一个 blank 占位', () => {
    const parsed = parseCharacterList('珠\n络\n诺');
    expect(parsed).toEqual(['', '珠', '络', '诺']);
    // 下标 0 必须是 blank，字符从 1 开始
    expect(parsed[1]).toBe('珠');
  });
});
