/**
 * 端侧 **OCR** 引擎的注册制入口（spec §4.1.9）。
 *
 * 图片识别日程的第一段是**端侧 OCR**：图片 → 纯文字（中英文混排的通知、行程单、课程表）。
 * **图片不出手机**，出手机的只有 OCR 出来的文字（第二段的解析在服务端）。
 *
 * <p><b>为什么是注册制而不是直接 import</b>：OCR 引擎是**原生模块**，
 * `require` 它会让 Metro 在打包阶段直接失败（Expo Go 里根本没有这个模块）。
 * 所以这里只放接口 + `registerOcrEngine`，真正的实现在开发版 / 正式版启动时注册；
 * Expo Go / Web 下保持未注册，调用方据此**如实说明「需要开发版构建」**，
 * 而不是让整个 App 起不来，也不是假装识别了一下。
 */

/** 端侧 OCR：图片 → 文字。 */
export interface OcrEngine {
  /** 引擎名（进日志与「由谁识别」的说明） */
  name(): string;
  recognizeText(uri: string): Promise<string>;
}

/** 端侧识别不可用（没注册引擎）：调用方要如实说明，不要静默降级到别的通道。 */
export class DeviceRecognitionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceRecognitionUnavailable';
  }
}

let ocrEngine: OcrEngine | null = null;

/** 由开发版 / 正式版构建注册端侧 OCR 引擎（Expo Go 下永远不会被调用）。 */
export function registerOcrEngine(engine: OcrEngine): void {
  ocrEngine = engine;
}

/** 端侧 OCR：图片 → 文字。文字随后交给服务端解析（`/ai/events/parse-text`）。 */
export async function ocrImageText(uri: string): Promise<string> {
  if (!ocrEngine) {
    throw new DeviceRecognitionUnavailable(
      '端侧识别需要开发版构建（Expo Go 里没有 OCR 模块）',
    );
  }
  const text = await ocrEngine.recognizeText(uri);
  // 诊断用：OCR 到底认出了什么，是这条链路最容易出错的一环（空文本 / 乱码）
  console.log(`[vision] OCR(${ocrEngine.name()}) 得到 ${text.length} 字：${text.slice(0, 60)}`);
  return text;
}
