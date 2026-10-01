/**
 * PP-OCR 识别头（CRNN + CTC）的解码。
 *
 * <p>模型的输出是 `[T, C]` 的逐帧得分：`T` 个时间步、`C` 类。CTC 解码的规则非常容易写错，
 * 而且错了只会表现为「识别出来的字多一个少一个」，很难往解码上想：
 *
 * 1. **下标 0 是 blank**（PP-OCR 的约定，不是最后一个）；
 * 2. **连续重复要先合并再删 blank** —— 顺序反了的话，「大大」这种叠字会变成一个「大」，
 *    而「大 · blank · 大」会被错当成叠字（先合并再去 blank 才是对的）；
 * 3. 字符表从**模型元数据**里读（PP-OCRv4 的 ONNX 自带 `character` 字段，换行分隔），
 *    不靠外部字典文件的顺序猜——差一位就会整行错位。
 */

export interface RecognitionResult {
  text: string;
  /** 保留字符的平均置信度（0..1）；一个字都没解出来时是 0 */
  confidence: number;
}

/**
 * 模型元数据里的 `character` 字段 → 字符表。
 *
 * <p>约定：下标 0 是 blank 占位，所以这里在最前面补一个空串，让 `characters[i]` 直接对应
 * 模型输出的第 i 类。
 */
export function parseCharacterList(metadataValue: string): string[] {
  const chars = metadataValue.split('\n').filter((item) => item.length > 0);
  return ['', ...chars];
}

/**
 * `[T, C]` 得分矩阵 → 一行文字。
 *
 * @param scores 行优先的得分（长度必须 ≥ T×C）；onnxruntime 给的是 Float32Array
 * @param timesteps T
 * @param classes C（应等于字符表长度）
 * @param characters 由 {@link parseCharacterList} 得到，下标 0 为 blank
 */
export function decodeCtc(
  scores: ArrayLike<number>,
  timesteps: number,
  classes: number,
  characters: string[],
): RecognitionResult {
  let text = '';
  let previous = -1;
  let kept = 0;
  let probabilitySum = 0;

  for (let t = 0; t < timesteps; t += 1) {
    const base = t * classes;
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let c = 0; c < classes; c += 1) {
      const score = scores[base + c] ?? -Infinity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = c;
      }
    }
    // 先按时间顺序合并重复帧，再丢掉 blank —— 反过来会把「a·blank·a」错并成一个 a
    if (bestIndex === previous) {
      continue;
    }
    previous = bestIndex;
    if (bestIndex === 0) {
      continue; // blank
    }
    const char = characters[bestIndex];
    if (char === undefined) {
      continue; // 字符表比模型短（元数据缺失）：宁可少一个字，也不要写出一串 undefined
    }
    text += char;
    kept += 1;
    probabilitySum += bestScore;
  }

  return {
    text,
    confidence: kept > 0 ? probabilitySum / kept : 0,
  };
}

/** 整行置信度低于这个值时，调用方多半该把它当成「没认出来」而不是硬写进日程。 */
export const MIN_LINE_CONFIDENCE = 0.5;
