/**
 * 把 ONNX Runtime（`onnxruntime-react-native`）包成 {@link OcrSession}。
 *
 * <p>**这是整条链路里唯一直接碰推理引擎的文件**，也是唯一不能单测的一层：它一 import
 * 就会让 Expo Go 的打包炸掉（原生模块不在），所以只能被 `paddleOcr.ts` 动态加载
 * （见 `vision/register.ts` 的说明）。为了让它薄到不用测，这里只做三件事：
 * 建 session、喂张量、把输出摊平成「哪一维是什么」。
 *
 * <p>输入 / 输出**名字不写死**，从 session 自己的 `inputNames` / `outputNames` 读——
 * 三个模型分别叫 `x` → `sigmoid_0.tmp_0` / `softmax_11.tmp_0` / `save_infer_model/scale_0.tmp_1`，
 * 换一版转换就变，写死只会得到一句「找不到输入」。
 */

import { InferenceSession, Tensor } from 'onnxruntime-react-native';

import type { ClsOutput, DetOutput, OcrSession, RecOutput } from './pipeline';

export interface OcrModelPaths {
  /** 检测（DB）模型：图 → 文字块概率图 */
  det: string;
  /** 识别（CRNN+CTC）模型：文字行 → 逐帧得分 */
  rec: string;
  /** 方向分类模型（可选）：这行是不是倒的 */
  cls?: string;
}

/** 每个头累计耗时的毫秒数——「端侧识别慢在哪一步」只能靠它回答。 */
export interface OcrTimings {
  detectMs: number;
  classifyMs: number;
  recognizeMs: number;
  /** 识别头跑了几次（= 识别了几行） */
  recognizeCalls: number;
}

export interface TimedOcrSession extends OcrSession {
  timings: OcrTimings;
  /** 识别模型的类别数（来自 ONNX 输出的最后一维），用来给字符表做交叉校验 */
  recClasses: number | undefined;
}

/** 建好三个 session 并返回 {@link TimedOcrSession}。路径是**本地文件路径**（file:// 也行）。 */
export async function createOcrSession(paths: OcrModelPaths): Promise<TimedOcrSession> {
  const det = await InferenceSession.create(paths.det);
  const rec = await InferenceSession.create(paths.rec);
  const cls = paths.cls ? await InferenceSession.create(paths.cls) : null;

  const timings: OcrTimings = { detectMs: 0, classifyMs: 0, recognizeMs: 0, recognizeCalls: 0 };

  return {
    timings,
    recClasses: lastDimension(rec),

    async detect(tensor, width, height): Promise<DetOutput> {
      const started = Date.now();
      const output = await runSingle(det, tensor, [1, 3, height, width]);
      timings.detectMs += Date.now() - started;
      const [, channels, outHeight, outWidth] = output.dims;
      if (!channels || !outHeight || !outWidth) {
        throw new Error(`检测输出形状不认识：${output.dims.join('×')}`);
      }
      return { scores: output.data, width: outWidth, height: outHeight };
    },

    async recognize(tensor, width, height): Promise<RecOutput> {
      const started = Date.now();
      const output = await runSingle(rec, tensor, [1, 3, height, width]);
      timings.recognizeMs += Date.now() - started;
      timings.recognizeCalls += 1;
      const [, timesteps, classes] = output.dims;
      if (!timesteps || !classes) {
        throw new Error(`识别输出形状不认识：${output.dims.join('×')}`);
      }
      return { scores: output.data, timesteps, classes };
    },

    async classify(tensor, width, height): Promise<ClsOutput> {
      if (!cls) {
        throw new Error('没有加载方向分类模型');
      }
      const started = Date.now();
      const output = await runSingle(cls, tensor, [1, 3, height, width]);
      timings.classifyMs += Date.now() - started;
      // 两类的 softmax：第 0 类是正着、第 1 类是倒着（官方 cls 的约定）
      const upright = output.data[0] ?? 0;
      const upsideDown = output.data[1] ?? 0;
      return { rotated: upsideDown > upright, score: upsideDown };
    },
  };
}

/**
 * 跑一次单输入单输出的推理。
 *
 * <p>三个模型都是「一个输入 tensor → 一个输出 tensor」，所以这里不做通用化：
 * 名字从 session 读，形状按 `[N, C, H, W]`（检测 / 识别 / 分类都一样）。
 */
async function runSingle(
  session: InferenceSession,
  data: Float32Array,
  dims: number[],
): Promise<{ data: Float32Array; dims: number[] }> {
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) {
    throw new Error('模型没有输入或输出');
  }
  const results = await session.run({
    [inputName]: new Tensor('float32', data, dims),
  });
  const output = results[outputName];
  if (!output || !(output.data instanceof Float32Array)) {
    throw new Error(`模型没有返回 ${outputName} 的浮点张量`);
  }
  return { data: output.data, dims: [...output.dims] };
}

/** 输出的最后一维（rec 的类别数）。动态维度（-1）当成「读不到」。 */
function lastDimension(session: InferenceSession): number | undefined {
  const metadata = session.outputMetadata?.[0];
  if (!metadata?.isTensor) {
    return undefined;
  }
  const last = metadata.shape[metadata.shape.length - 1];
  return typeof last === 'number' && last > 0 ? last : undefined;
}
