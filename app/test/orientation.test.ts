import { describe, expect, it } from 'vitest';

import {
  isReadable,
  pickBestReading,
  ROTATION_ATTEMPTS,
  type OrientationReading,
} from '../src/vision/ppocr/orientation';

/**
 * 整图朝向的重试策略。
 *
 * 用户反馈「照片横着的时候一个字都认不出」：端侧模型只有逐框的 180 度方向分类，
 * 整图横躺（90 / 270 度）它救不回来。这里盯的是「怎么在多朝向之间选」这条判断。
 */
describe('整图朝向的重试', () => {
  it('候选朝向是 0 / 90 / 270，且相机先试「本来就是正的」', () => {
    expect([...ROTATION_ATTEMPTS]).toEqual([0, 90, 270]);
    expect(ROTATION_ATTEMPTS[0]).toBe(0);
  });

  it('认出的字够多又够准才算「认出来了」，否则继续试别的朝向', () => {
    expect(isReadable({ chars: 30, confidence: 0.9 })).toBe(true);
    // 横躺时偶尔解出的三两个乱码**不算**成功，否则会把垃圾文字交给用户
    expect(isReadable({ chars: 3, confidence: 0.9 })).toBe(false);
    expect(isReadable({ chars: 30, confidence: 0.2 })).toBe(false);
    // 边界
    expect(isReadable({ chars: 8, confidence: 0.5 })).toBe(true);
  });

  it('多次尝试里挑认字最多的那次（横躺的 90 度会被选中）', () => {
    const readings: OrientationReading[] = [
      { degrees: 0, chars: 2, confidence: 0.7 },
      { degrees: 90, chars: 128, confidence: 0.92 },
    ];
    expect(pickBestReading(readings)?.degrees).toBe(90);
  });

  it('字数相同才比置信度；空数组返回 null', () => {
    expect(
      pickBestReading([
        { degrees: 0, chars: 40, confidence: 0.6 },
        { degrees: 270, chars: 40, confidence: 0.8 },
      ])?.degrees,
    ).toBe(270);
    expect(pickBestReading([])).toBeNull();
  });
});
