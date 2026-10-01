/**
 * 端侧 OCR 的实现：**PaddleOCR PP-OCRv4**（ONNX Runtime + 自写流水线）。
 *
 * <p>为什么不是 ML Kit（那份实现留在 `mlkitOcr.ts`，随时能切回去）：中文印刷体的识别率，
 * 用户实测点名要 PP-OCR。为什么不是 Paddle-Lite：它的 Android AAR 没有发布到 Maven
 * （只剩 GitHub release 可淘）；而 `onnxruntime-react-native` 在 Maven 上就有，模型也能
 * 直接拿现成的 ONNX——**一份推理核心两端跑**，iOS / Android 不用各写一套原生模块。
 *
 * <p>三个模型与字典都是**资源**（`app/assets/models/ppocr/`，不进版本库，用
 * `scripts/fetch_ppocr_models.sh` 拉），由 Metro 打进包里（`app/metro.config.js`
 * 给 `assetExts` 补了 `onnx` / `txt`）。**运行时先把资源落到本地文件**再交给
 * ONNX Runtime：它要的是文件路径，不是 `asset://` 这种 URI。
 *
 * <p>**只能在开发版 / 正式版里用**：Expo Go 没有 `onnxruntime-react-native` 这个原生模块，
 * 所以本文件由 `register.ts` 动态 import，Expo Go 下根本不会加载它。
 */

import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';

import clsModelAsset from '../../assets/models/ppocr/ch_ppocr_mobile_v2.0_cls_infer.onnx';
import detModelAsset from '../../assets/models/ppocr/ch_PP-OCRv4_det_infer.onnx';
import recModelAsset from '../../assets/models/ppocr/ch_PP-OCRv4_rec_infer.onnx';
import keyAsset from '../../assets/models/ppocr/ppocr_keys_v1.txt';
import type { OcrEngine } from './onDevice';
import { buildCharacterList } from './ppocr/charset';
import { readCroppedRgba, readImageSize, readScaledRgba } from './ppocr/imageIo';
import { createOcrSession, type TimedOcrSession } from './ppocr/ortRunner';
import { recognizeLines, type OcrImageSource, type OcrLine } from './ppocr/pipeline';

/** 取像素的三个动作包成流水线要的形状；原生调用全在 `imageIo.ts` 里。 */
const imageSource: OcrImageSource = {
  size: (uri) => readImageSize(uri),
  scaled: (uri, width, height) => readScaledRgba(uri, { width, height }),
  cropped: (uri, region, width, height) =>
    readCroppedRgba(
      uri,
      {
        originX: region.x,
        originY: region.y,
        width: region.width,
        height: region.height,
      },
      { width, height },
    ),
};

/**
 * 三个模型与字典都是 16MB 级的二进制，**首次识别时才加载并缓存**：
 * 装在 App 启动路径上会让冷启动平白多等一两秒，而用户不一定会用图片识别。
 */
let ready: Promise<{ session: TimedOcrSession; characters: string[] }> | null = null;

function ensureReady(): Promise<{ session: TimedOcrSession; characters: string[] }> {
  if (!ready) {
    ready = load()
      // 失败要能重试：第一次可能是资源还没落盘 / 内存不够，缓存住失败会一直报同一个错
      .catch((cause) => {
        ready = null;
        throw cause;
      });
  }
  return ready;
}

async function load(): Promise<{ session: TimedOcrSession; characters: string[] }> {
  const started = Date.now();
  const [det, rec, cls, dictUri] = await Promise.all([
    localFileUri(detModelAsset),
    localFileUri(recModelAsset),
    localFileUri(clsModelAsset),
    localFileUri(keyAsset),
  ]);
  const dictText = await new File(dictUri).text();
  const session = await createOcrSession({
    det: filePath(det),
    rec: filePath(rec),
    cls: filePath(cls),
  });
  // 字符表按**模型报出来的类别数**校验：对不上就当场抛，别等到识别出一串错字才发现
  const characters = buildCharacterList(dictText, session.recClasses);
  console.log(
    `[vision] PaddleOCR 模型就绪：${Date.now() - started}ms，字符表 ${characters.length} 类`
    + `（模型报 ${session.recClasses ?? '未知'}）`,
  );
  return { session, characters };
}

/**
 * 资源 → **本地 `file://` URI**。
 *
 * <p>三种环境下三种走法，但结果都是「缓存目录里的一个真实文件」：
 * - **开发版**：Metro 通过 http 提供资源，`downloadAsync` 拷到缓存目录；
 * - **正式版**：资源在 APK 里（`res/raw/<标识名>`，aapt2 打包时会把它改名成 `-T`、`YD`
 *   这种短名，但**资源标识名不变**）。RN 给我们的 URI 就是那个标识名（没有扩展名、没有斜杠），
 *   原生 `downloadAsync` 用 `resources.getIdentifier(名字, "raw", 包名)` 找到它再拷进缓存目录
 *   ——字体（Ionicons.ttf）走的也是这条路，图标能显示就说明这条链是通的；
 * - **Expo Go / expo-updates**：`localUri` 会被换成 `file:///android_res/...`，原生那边同样能读。
 *
 * <p>所以这里只做一件事：确保最后拿到的是 `file://` 开头的**真实文件**。拿不到就当场抛——
 * 一个「不是文件的 URI」被塞给推理引擎，报出来的错会离原因很远。
 */
async function localFileUri(moduleId: number): Promise<string> {
  const asset = Asset.fromModule(moduleId);
  if (!asset.downloaded) {
    await asset.downloadAsync();
  }
  const uri = asset.localUri ?? asset.uri;
  if (!uri.startsWith('file://')) {
    throw new Error(`资源没有落到本地文件（${uri}）——先跑一次 scripts/fetch_ppocr_models.sh 并重新出包`);
  }
  return uri;
}

/** ONNX Runtime 的原生侧只要路径。它自己也认 `file:/` 前缀，但少一层解析少一个坑。 */
function filePath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

function formatLines(lines: OcrLine[]): string {
  return lines
    .map((line) => line.text)
    .join('\n')
    .trim();
}

export const paddleOcrEngine: OcrEngine = {
  name: () => 'PaddleOCR PP-OCRv4',

  /** 提前把三个模型 load 起来（用户点开「上传图片」面板时调，见 `warmUpOcrEngine`）。 */
  warmUp: async (): Promise<void> => {
    await ensureReady();
  },

  /**
   * 图片 → 纯文本（一行一行拼起来）。
   *
   * <p>耗时埋点在日志里：检测 + 识别各花了多少、识别了几行，出问题（慢 / 认不出）
   * 时这是第一手材料。ML Kit 那一版实测 1.5–1.7s，换引擎要能直接对比。
   */
  recognizeText: async (uri: string): Promise<string> => {
    const started = Date.now();
    const { session, characters } = await ensureReady();
    const before = { ...session.timings };
    try {
      const lines = await recognizeLines(uri, { image: imageSource, session, characters });
      const elapsed = Date.now() - started;
      console.log(
        `[vision] PaddleOCR 端侧：检测 ${session.timings.detectMs - before.detectMs}ms`
        + `（${lines.length} 行，方向分类 ${session.timings.classifyMs - before.classifyMs}ms）`
        + ` → 识别 ${session.timings.recognizeMs - before.recognizeMs}ms`
        + `（${session.timings.recognizeCalls - before.recognizeCalls} 行）→ 合计 ${elapsed}ms`,
      );
      return formatLines(lines);
    } catch (cause) {
      // 认错字可以忍，「一个字都没读出来还假装成功」不行：这里如实抛给界面
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`端侧 OCR 失败：${detail}`);
    }
  },
};
