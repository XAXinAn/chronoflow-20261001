/**
 * 端侧 OCR 的实现：Google ML Kit 文本识别（中文脚本）。
 *
 * <p>为什么是它而不是 PaddleOCR-ONNX：ML Kit 的中文识别模型随 APK 打包（`text-recognition-chinese`），
 * 不需要自己写 DB 检测的后处理 + CTC 解码那一整套；代价是依赖 Google 服务（模拟器 / 国内机型上要留意）。
 * 接口是 `OcrEngine`，将来要换引擎只换这个文件。
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
