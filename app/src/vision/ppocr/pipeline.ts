/**
 * PP-OCR 的**整条流水线**：图片 → 一行行文字（带坐标）。
 *
 * <pre>
 * 规划输入 → 读缩放后的像素 → 补边 → 检测（DB）→ 二值化 / 连通域 / 过滤 / 外扩 → 映射回原图
 *   → 阅读顺序 → 逐框：裁剪 → 方向分类（可选）→ 识别（CRNN+CTC）→ CTC 解码
 * </pre>
 *
 * <p><b>为什么要分成「纯编排 + 注入依赖」两块</b>：真正碰原生（推理、读像素）的只有
 * `session` 与 `image` 两个接口，其余全是纯计算。这样这条最容易写错的链路
 * （框切偏、顺序乱了、字符表错一位）能在 node 里用假 session 端到端跑一遍，
 * 而不是只能上真机看图猜。
 *
 * <p>与官方实现的取舍：
 * - 识别**逐框单独跑**，不拼 batch。官方要凑 batch 是为了 GPU 吞吐；端侧一次也就十几行，
 *   省掉「按最长行补边再切回去」那套索引换算，出错面小得多（模型的宽高本来就是动态的）。
 * - 方向分类头是**可选的**（`session.classify` 没实现就跳过）：它只值 0.6MB，
 *   但省掉它是为了在「只想先跑通检测+识别」时能少一份模型。
 */

import {
  DET_BIN_THRESHOLD,
  DET_BOX_THRESHOLD,
  DET_MIN_SIZE,
  DET_UNCLIP_RATIO,
  binarize,
  clampRect,
  connectedComponents,
  filterBoxes,
  mapBoxToImage,
  orderBoxes,
  planDetInput,
  unclipRect,
  type Rect,
} from './detPost';
import { MIN_LINE_CONFIDENCE, decodeCtc, type RecognitionResult } from './decode';
import {
  DET_MEAN,
  DET_STD,
  REC_MEAN,
  REC_STD,
  padToCanvas,
  rotate180,
  toChwTensor,
  type RgbaImage,
} from './pixels';

/** 检测输入的最长边（官方 `det_limit_side_len`）。再大对手机本地识别也没收益了。 */
export const DET_LIMIT = 960;
/** 检测骨干下采样 32 倍，输入尺寸得是 32 的倍数。 */
export const DET_STRIDE = 32;
/** 识别头固定高度（官方 `rec_image_shape = [3, 48, 320]`）。 */
export const REC_HEIGHT = 48;
/** 识别头最大宽度。超长的行会被压扁——比整行丢掉好，也避免一次推理吃满内存。 */
export const REC_MAX_WIDTH = 320;
/** 识别头最小宽度（一个字的宽度都不够时，模型会报错或给垃圾）。 */
export const REC_MIN_WIDTH = 8;
/** 方向分类头的输入宽度（官方 `cls_image_shape = [3, 48, 192]`）。 */
export const CLS_WIDTH = 192;
/**
 * 一次最多识别多少行。
 *
 * <p>每行一次推理（实测 0.1–0.3s），不设上限的话一张满是文字的图能跑几分钟。
 * 按阅读顺序取前 N 行：通知类图片要的正是最上面那几行。
 */
export const MAX_LINES = 48;

/** 检测头的输出：`[1, 1, H, W]` 的概率图。 */
export interface DetOutput {
  scores: Float32Array;
  width: number;
  height: number;
}

/** 识别头的输出：`[T, C]` 的逐帧得分（onnxruntime 会给成扁平的 Float32Array）。 */
export interface RecOutput {
  scores: Float32Array;
  timesteps: number;
  classes: number;
}

/** 方向分类头的输出：这行字是不是倒的。 */
export interface ClsOutput {
  rotated: boolean;
  /** 判定为「倒着」的概率，进日志用 */
  score: number;
}

/** 三个模型（检测 / 识别 / 方向分类）的统一入口，由 {@link ./ortRunner} 用 ONNX Runtime 实现。 */
export interface OcrSession {
  detect(tensor: Float32Array, width: number, height: number): Promise<DetOutput>;
  recognize(tensor: Float32Array, width: number, height: number): Promise<RecOutput>;
  /** 可选：没接方向分类模型就不传，倒着的文字会按原样识别 */
  classify?(tensor: Float32Array, width: number, height: number): Promise<ClsOutput>;
}

/** 取像素（缩放 / 裁剪）——由 {@link ../ppocr/imageIo} 用原生图像 API 实现。 */
export interface OcrImageSource {
  size(uri: string): Promise<{ width: number; height: number }>;
  scaled(uri: string, width: number, height: number): Promise<RgbaImage>;
  cropped(uri: string, region: Rect, width: number, height: number): Promise<RgbaImage>;
}

/** 识别出来的一行字（坐标是**原图**坐标系，给后续按位置纠错 / 调试用）。 */
export interface OcrLine {
  text: string;
  confidence: number;
  box: Rect;
  /** 这行是被转正过的（方向分类头判为倒置） */
  rotated: boolean;
}

export interface OcrPipelineDeps {
  image: OcrImageSource;
  session: OcrSession;
  /** 字符表（下标 0 是 blank），见 {@link ./charset} */
  characters: string[];
}

/** 图片 → 一行行文字。没识别出任何一行时返回**空数组**（不是抛错）。 */
export async function recognizeLines(
  uri: string,
  deps: OcrPipelineDeps,
): Promise<OcrLine[]> {
  const size = await deps.image.size(uri);
  const boxes = await detectLineBoxes(uri, size, deps);

  const lines: OcrLine[] = [];
  for (const box of boxes) {
    const line = await readLine(uri, box, deps);
    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

/** 检测 + 后处理 → 原图坐标系下的行框（已按阅读顺序、已截到 {@link MAX_LINES}）。 */
async function detectLineBoxes(
  uri: string,
  size: { width: number; height: number },
  deps: OcrPipelineDeps,
): Promise<Rect[]> {
  const plan = planDetInput(size.width, size.height, DET_LIMIT, DET_STRIDE);
  const scaled = await deps.image.scaled(uri, plan.scaledWidth, plan.scaledHeight);
  // 补的边放在**左侧 / 上侧各一半**（见 planDetInput 的 padX/padY），所以缩放后的图要
  // 摆到 (padX, padY)；映射回原图时再减掉，两边必须用同一套值
  const canvas = padToCanvas(scaled, plan.inputWidth, plan.inputHeight, plan.padX, plan.padY);
  const tensor = toChwTensor(canvas, DET_MEAN, DET_STD, 'rgb');
  const output = await deps.session.detect(tensor, plan.inputWidth, plan.inputHeight);

  if (output.width * output.height !== output.scores.length) {
    throw new Error(
      `检测输出对不上：${output.width}×${output.height} 需要 ${output.width * output.height} 个数，实际 ${output.scores.length}`,
    );
  }

  const mask = binarize(output.scores, output.height, output.width, DET_BIN_THRESHOLD);
  const blocks = filterBoxes(
    connectedComponents(mask, output.scores, output.height, output.width),
    DET_BOX_THRESHOLD,
    DET_MIN_SIZE,
  );
  const boxes = blocks.map((block) =>
    clampRect(
      mapBoxToImage(
        // 外扩在**检测输入图**上做（那里才有「文字块」的边界），再映射回原图
        unclipRect(block, DET_UNCLIP_RATIO, { width: output.width, height: output.height }),
        plan,
      ),
      size,
    ),
  );
  return orderBoxes(boxes).slice(0, MAX_LINES);
}

/** 一个框 → 一行文字；认不出来（空文本 / 置信度太低）返回 null。 */
async function readLine(
  uri: string,
  box: Rect,
  deps: OcrPipelineDeps,
): Promise<OcrLine | null> {
  const width = clampRecWidth(Math.round((box.width * REC_HEIGHT) / box.height));
  let pixels = await deps.image.cropped(uri, box, width, REC_HEIGHT);

  let rotated = false;
  if (deps.session.classify) {
    const cls = await deps.image.cropped(uri, box, Math.min(width, CLS_WIDTH), REC_HEIGHT);
    const verdict = await deps.session.classify(
      toChwTensor(cls, REC_MEAN, REC_STD, 'bgr'),
      cls.width,
      cls.height,
    );
    if (verdict.rotated) {
      pixels = rotate180(pixels);
      rotated = true;
    }
  }

  const output = await deps.session.recognize(
    toChwTensor(pixels, REC_MEAN, REC_STD, 'bgr'),
    pixels.width,
    pixels.height,
  );
  if (output.timesteps * output.classes !== output.scores.length) {
    throw new Error(
      `识别输出对不上：${output.timesteps}×${output.classes} 需要 ${output.timesteps * output.classes} 个数，实际 ${output.scores.length}`,
    );
  }

  const decoded: RecognitionResult = decodeCtc(
    output.scores,
    output.timesteps,
    output.classes,
    deps.characters,
  );
  // 全是空格也算是没认出来（模型在纯噪声上会吐一串空格，看着像「有字」）
  if (decoded.text.trim().length === 0 || decoded.confidence < MIN_LINE_CONFIDENCE) {
    return null;
  }
  return { text: decoded.text, confidence: decoded.confidence, box, rotated };
}

function clampRecWidth(width: number): number {
  return Math.max(REC_MIN_WIDTH, Math.min(REC_MAX_WIDTH, width));
}
