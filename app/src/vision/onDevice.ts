import type { RecognizedEventDraft } from '../domain/vision';
import { DeviceRecognitionUnavailable } from './recognizer';

/**
 * 端侧轻量多模态识别（spec §4.1.9）。
 *
 * <p>模型选型与理由：
 * - 默认 **Qwen2.5-VL-3B-Instruct（GGUF Q4_K_M，约 2.3GB）**：中文通知/行程单的识别质量
 *   明显好于 1B 级模型，4GB 以上内存的机器能跑；
 * - 低配降级 **SmolVLM-500M（GGUF，约 0.5GB）**：能跑，但中文密集文本容易漏字。
 *
 * <p>接入用 **llama.rn**（GGUF，可直接换模型文件）而不是 executorch：不需要导出/转换链。
 *
 * <p><b>端侧推理需要 Dev Client 构建</b>：`llama.rn` 是原生模块，Expo Go 里不存在。
 * 所以这里用**动态 require**并捕获异常，Expo Go 下会抛出「需要 Dev Client」，
 * 由上层回落到服务端识别——而不是让整个 App 起不来。
 */

/** 默认模型（可换成 SmolVLM-500M 走低配路线）。 */
const DEFAULT_MODEL = {
  name: 'Qwen2.5-VL-3B-Instruct (Q4_K_M)',
  file: 'qwen2.5-vl-3b-instruct-q4_k_m.gguf',
};

export function describeModel(): string {
  return `on-device · ${DEFAULT_MODEL.name}`;
}

/** 端侧推理引擎：由 Dev Client 构建注册（见文件头说明）。 */
export interface OnDeviceEngine {
  /** 模型是否已下载并在本机可用 */
  isReady(): Promise<boolean>;
  /** 图片 → 日程草稿（与后端同一套约束：提示词 + 只取 JSON + 容错解析） */
  recognize(uri: string): Promise<RecognizedEventDraft[]>;
}

let engine: OnDeviceEngine | null = null;

/**
 * 注册端侧引擎。
 *
 * <p>为什么用注册而不是直接 import：**Expo Go 里不能出现对 `llama.rn` 的静态引用**——
 * Metro 在打包阶段就会因为解析不到这个包而整包失败。所以端侧引擎只在 Dev Client 构建里
 * 由 `vision/engine.llama.ts` 注册，Expo Go 下这里保持 null，识别自动回落服务端。
 */
export function registerOnDeviceEngine(next: OnDeviceEngine): void {
  engine = next;
}

export async function recognizeOnDevice(uri: string): Promise<RecognizedEventDraft[]> {
  if (!engine) {
    throw new DeviceRecognitionUnavailable(
      '端侧识别需要 Dev Client 构建（llama.rn 不在 Expo Go 里），已改用服务器识别',
    );
  }
  if (!(await engine.isReady())) {
    throw new DeviceRecognitionUnavailable('端侧模型还没有下载到本机，已改用服务器识别');
  }
  return engine.recognize(uri);
}
