/**
 * 整图朝向的重试策略（纯逻辑，可在 node 里单测）。
 *
 * 为什么要它：PP-OCR 的流水线里只有一个「逐框 180 度」的方向分类头，只能把
 * 「这一行是倒着的」转正。手机拍照时整张图横躺 90 / 270 度（竖屏机器拍横屏内容、
 * 或相册里手动转过）时，检测框会变成竖条、方向分类也救不回来，
 * 结果就是「一个字都认不出」——用户反馈的正是这个。
 *
 * 修法不是去猜朝向，而是「按几个候选朝向各跑一次，谁认出来的字多又准就用谁」：
 * 正着的图第一次就过（不增加耗时），横躺的图最多多跑一次。
 * 180 度不在候选里（逐框分类已经覆盖）；镜像翻转靠旋转解决不了，不在这里处理。
 */

/** 候选朝向（顺时针角度）。顺序就是尝试顺序：先试「本来就是正的」。 */
export const ROTATION_ATTEMPTS = [0, 90, 270] as const;

export type RotationDegrees = (typeof ROTATION_ATTEMPTS)[number];

/** 一次尝试的读数。 */
export interface OrientationReading {
  /** 这次用的旋转角度 */
  degrees: RotationDegrees;
  /** 认出来的非空白字符数 */
  chars: number;
  /** 各行置信度的平均（一行都没有时为 0） */
  confidence: number;
}

/** 判定「这次算认出来了」的阈值。 */
export const READABLE_MIN_CHARS = 8;
export const READABLE_MIN_CONFIDENCE = 0.5;

/**
 * 这次读数算不算「认出来了」——够就不要再试别的朝向。
 *
 * 门槛刻意保守：宁可多试一次，也不要把「横躺时恰好认出两个乱码」当成成功，
 * 那会让用户拿到一堆垃圾文字，比明确失败更难排查。
 */
export function isReadable(
  reading: Omit<OrientationReading, 'degrees'>,
  minChars: number = READABLE_MIN_CHARS,
  minConfidence: number = READABLE_MIN_CONFIDENCE,
): boolean {
  return reading.chars >= minChars && reading.confidence >= minConfidence;
}

/**
 * 从若干次尝试里挑最好的那次：先比认出的字数，再比置信度。
 *
 * 为什么字数优先：横躺的图上检测器仍会吐出一些竖条框，偶尔也能解出三两个字；
 * 而转正之后一次能出几十个字——字数是最能区分「认出来了」和「瞎猜」的信号。
 * 字数相同才看置信度。空数组返回 null（调用方据此如实报「没认出文字」）。
 */
export function pickBestReading(readings: OrientationReading[]): OrientationReading | null {
  let best: OrientationReading | null = null;
  for (const reading of readings) {
    if (
      best === null ||
      reading.chars > best.chars ||
      (reading.chars === best.chars && reading.confidence > best.confidence)
    ) {
      best = reading;
    }
  }
  return best;
}
