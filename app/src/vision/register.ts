/**
 * 在**开发版 / 正式版**启动时注册端侧 OCR 引擎。
 *
 * <p>为什么要动态 import：OCR 是原生模块（`onnxruntime-react-native` / ML Kit），
 * **Expo Go 里不存在**。静态 import 会让 Expo Go 的整包打包阶段就出问题。
 * 这里用 `await import()` 包在 try/catch 里：拿不到就当没注册，界面据此**如实说明**
 * 「端侧识别需要开发版构建」，而不是让整个 App 起不来。
 *
 * <p>第二段（文字 → 日程草稿）在服务端做，所以这里只注册 OCR 这一件事。
 *
 * <p><b>当前用哪个引擎</b>：{@link PADDLE}——PaddleOCR PP-OCRv4（中文印刷体识别率更高，
 * 用户点名要的）。ML Kit 那份实现**保留**着（`mlkitOcr.ts`），出问题时把下面那个常量
 * 改成 `'mlkit'` 就能一行切回去，不用改别的代码。
 */

import { registerOcrEngine } from './onDevice';

/** 引擎开关：`paddle` = PaddleOCR PP-OCRv4（默认），`mlkit` = Google ML Kit 中文。 */
const ENGINE: 'paddle' | 'mlkit' = 'paddle';

let registered = false;

export async function registerBundledOcrEngine(): Promise<boolean> {
  if (registered) {
    return true;
  }
  try {
    if (ENGINE === 'mlkit') {
      const { mlkitOcrEngine } = await import('./mlkitOcr');
      registerOcrEngine(mlkitOcrEngine);
    } else {
      const { paddleOcrEngine } = await import('./paddleOcr');
      registerOcrEngine(paddleOcrEngine);
    }
    registered = true;
    return true;
  } catch {
    // Expo Go / Web：没有原生模块，保持未注册（调用方会提示需要开发版构建）
    return false;
  }
}
