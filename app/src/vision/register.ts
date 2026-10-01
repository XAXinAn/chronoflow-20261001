/**
 * 在**开发版 / 正式版**启动时注册端侧 OCR 引擎。
 *
 * <p>为什么要动态 import：OCR 是原生模块（`@react-native-ml-kit/text-recognition`），
 * **Expo Go 里不存在**。静态 import 会让 Expo Go 的整包打包阶段就出问题。
 * 这里用 `await import()` 包在 try/catch 里：拿不到就当没注册，界面据此**如实说明**
 * 「端侧识别需要开发版构建」，而不是让整个 App 起不来。
 *
 * <p>第二段（文字 → 日程草稿）在服务端做，所以这里只注册 OCR 这一件事。
 */

import { registerOcrEngine } from './onDevice';

let registered = false;

export async function registerBundledOcrEngine(): Promise<boolean> {
  if (registered) {
    return true;
  }
  try {
    const { mlkitOcrEngine } = await import('./mlkitOcr');
    registerOcrEngine(mlkitOcrEngine);
    registered = true;
    return true;
  } catch {
    // Expo Go / Web：没有原生模块，保持未注册（调用方会提示需要开发版构建）
    return false;
  }
}
