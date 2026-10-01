/**
 * 端侧 OCR 的实现：Google ML Kit 文本识别（中文脚本）。
 *
 * <p>⚠️ **当前不是默认引擎**：默认已是 PaddleOCR PP-OCRv4（`paddleOcr.ts`）——中文印刷体的识别率
 * 更好，用户点名要的。这份实现**刻意保留**：它是「一行切回去」的回退方案
 * （`register.ts` 里的 `ENGINE = 'mlkit'`），也是新引擎出问题时的对照基线
 * （真机实测 1.5–1.7s / 张通知图）。
 *
 * <p>它的好处是不用自己写 DB 检测后处理 + CTC 解码那一整套（模型随 APK 打包：
 * `text-recognition-chinese`），代价是依赖 Google 服务（模拟器 / 国内机型上要留意）。
 * 接口是 `OcrEngine`，换引擎只换实现文件。
 *
 * <p>**只能在开发版/正式版里用**：Expo Go 没有这个原生模块，`NativeModules.TextRecognition` 为空，
 * 调用会抛 LINKING_ERROR。所以这文件由 `register.ts` 动态 import，Expo Go 下根本不会加载它。
 */

import TextRecognition, { TextRecognitionScript } from '@react-native-ml-kit/text-recognition';

import type { OcrEngine } from './onDevice';

export const mlkitOcrEngine: OcrEngine = {
  name: () => 'ML Kit 中文 OCR',

  /**
   * 图片 → 纯文本。
   *
   * <p>用整图 `result.text`（按块/行拼好的），不自己按坐标重排：识别中文通知这类
   * 左对齐多行文本时，ML Kit 的行序就是阅读序，自己按 y 坐标排序反而容易把标点弄丢。
   */
  recognizeText: async (uri: string): Promise<string> => {
    const result = await TextRecognition.recognize(uri, TextRecognitionScript.CHINESE);
    return result.text ?? '';
  },
};
