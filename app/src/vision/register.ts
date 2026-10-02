/**
 * 在**开发版 / 正式版**启动时注册端侧 OCR 引擎。
 *
 * <p>为什么要动态 import：OCR 是原生模块（`onnxruntime-react-native` / ML Kit），
 * **Expo Go 里不存在**。静态 import 会让 Expo Go 的整包打包阶段就出问题。
 * 这里用 `await import()`：拿不到就如实说明「端侧识别需要开发版构建」，
 * 而不是让整个 App 起不来。
 *
 * <p><b>注册的是「代理」，真实现要等第一次用才加载</b>。这不是洁癖：2026-10-01 出过一版
 * 启动即闪退——`onnxruntime-react-native` 的原生库当时没做 16KB 页对齐，在 Android 15+
 * 的 16KB 页机型上加载失败，而**启动路径上就 import 了它**（注册引擎那一步），于是整个 App
 * 打不开（见 `scripts/patch-third-party-gradle.sh` 里 onnxruntime 那段）。
 * 原生库的问题当然要在原生侧修（已修 + 构建期硬卡），但**启动路径上不碰原生模块**这条
 * 防线值得留着：引擎加载失败最多让「图片识别」这个功能报错，不该把整个 App 拖下水。
 *
 * <p>第二段（文字 → 日程草稿）在服务端做，所以这里只注册 OCR 这一件事。
 *
 * <p><b>当前用哪个引擎</b>：{@link PADDLE}——PaddleOCR PP-OCRv4（中文印刷体识别率更高，
 * 用户点名要的）。ML Kit 那份实现**保留**着（`mlkitOcr.ts`），出问题时把下面那个常量
 * 改成 `'mlkit'` 就能一行切回去，不用改别的代码。
 */

import { DeviceRecognitionUnavailable, registerOcrEngine, type OcrEngine } from './onDevice';
import { NativeModules } from 'react-native';

/** 引擎开关：`paddle` = PaddleOCR PP-OCRv4（默认），`mlkit` = Google ML Kit 中文。 */
const ENGINE: 'paddle' | 'mlkit' = 'paddle';

let registered = false;
/** 真实现的加载结果，缓存住（成功与失败都缓存：失败重试没有意义，反而会反复弹原生错误） */
let engine: Promise<OcrEngine> | null = null;

export function registerBundledOcrEngine(): boolean {
  if (registered) {
    return true;
  }
  registerOcrEngine({
    name: () => (ENGINE === 'mlkit' ? 'ML Kit 中文 OCR' : 'PaddleOCR PP-OCRv4'),
    recognizeText: async (uri) => (await loadEngine()).recognizeText(uri),
    warmUp: async () => {
      await loadEngine();
    },
  });
  registered = true;
  return true;
}

/** 第一次真正用到时才把实现（连同原生模块）加载进来。 */
function loadEngine(): Promise<OcrEngine> {
  if (!engine) {
    engine = importEngine();
  }
  return engine;
}

async function importEngine(): Promise<OcrEngine> {
  try {
    if (ENGINE === 'mlkit') {
      const { mlkitOcrEngine } = await import('./mlkitOcr');
      return mlkitOcrEngine;
    }
    /*
     * **先看原生模块在不在，再 import**。
     *
     * `onnxruntime-react-native` 在模块初始化时会执行 `NativeModules.Onnxruntime.install()`；
     * 如果这个原生模块没被注册（自动链接漏了、或这台设备没带这个库），它抛的是 TypeError，
     * 而 release 包里 RN 会把「模块加载阶段的异常」当**致命错误直接杀进程**——
     * JS 的 try/catch 拦不住（异常已经被 ExceptionsManager 上报了）。
     *
     * 代价就是 2026-10-01/02 那两次闪退：一次在启动、一次在点「上传图片」。
     * 所以这里提前判一下：没有原生模块就**不 import**，让这个功能如实报「不可用」。
     */
    if (NativeModules.Onnxruntime == null) {
      throw new DeviceRecognitionUnavailable(
        '这个安装包里的本地识别库没就绪（请更新到最新版本）',
      );
    }
    const { paddleOcrEngine } = await import('./paddleOcr');
    return paddleOcrEngine;
  } catch (cause) {
    // Expo Go / Web / 原生模块加载失败：如实告诉用户，不静默降级到别的通道
    console.log(`[vision] 端侧 OCR 引擎加载失败（${ENGINE}）：${String(cause)}`);
    throw new DeviceRecognitionUnavailable(
      '端侧识别需要开发版构建（Expo Go 里没有 OCR 模块），或这台设备加载不了本地识别库',
    );
  }
}
