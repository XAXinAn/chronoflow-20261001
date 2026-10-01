/**
 * 「图片 → 张量」这一段（PP-OCR 的预处理）。
 *
 * <p>ONNX Runtime 只吃数字，所以不管是 iOS 还是 Android，都得先把图片解成像素。
 * 这里的分工刻意分成两半：
 *
 * 1. **缩放 / 裁剪交给 `expo-image-manipulator`**（原生实现、两端都有、快）；
 * 2. **解码与归一化用纯 JS**（`jpeg-js` + 自己拼 NCHW），也就是**一份代码两端跑**——
 *    这正是选 ONNX Runtime 而不是各写一套原生模块的原因。
 *
 * <p>归一化参数必须与训练时一致，否则识别会整体变差但不报错：
 * 检测用 ImageNet 的 mean/std，识别用 0.5/0.5（等价于 `v/127.5 - 1`）。
 * **通道顺序两个头不一样**，见 {@link ChannelOrder}。
 */

import { decode as decodeJpeg } from 'jpeg-js';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA，每像素 4 字节，行优先 */
  data: Uint8Array;
}

/** 检测头的归一化（ImageNet）。 */
export const DET_MEAN: [number, number, number] = [0.485, 0.456, 0.406];
export const DET_STD: [number, number, number] = [0.229, 0.224, 0.225];
/** 识别头的归一化：等价于 `v / 127.5 - 1`。 */
export const REC_MEAN: [number, number, number] = [0.5, 0.5, 0.5];
export const REC_STD: [number, number, number] = [0.5, 0.5, 0.5];

/**
 * 张量的通道顺序。
 *
 * <p><b>检测头要 RGB、识别头（含方向分类）要 BGR</b>——这不是笔误，是 PP-OCR 官方流水线的
 * 既有事实：检测的预处理里有一句 `img[:, :, ::-1]`（把 cv2 读出来的 BGR 翻成 RGB），
 * 而识别的 `resize_norm_img` **不翻**，于是模型是在 BGR 上训练的。
 *
 * <p>搞反了不会报错，只会让识别率悄悄掉一截（中文的笔画密度对通道很敏感），
 * 是这类端侧集成最经典的坑之一。
 */
export type ChannelOrder = 'rgb' | 'bgr';

/** RN 里没有 `Buffer`/`atob` 的保证，base64 自己解——20 行，省一个 polyfill 依赖。 */
export function base64ToBytes(base64: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < alphabet.length; i += 1) {
    lookup[alphabet.charCodeAt(i)] = i;
  }
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let position = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const value = lookup[clean.charCodeAt(i)];
    if (value < 0) {
      continue;
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[position] = (buffer >> bits) & 0xff;
      position += 1;
    }
  }
  return out.subarray(0, position);
}

/** JPEG 字节 → RGBA 像素。 */
export function decodeJpegBytes(bytes: Uint8Array): RgbaImage {
  const decoded = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
  return {
    width: decoded.width,
    height: decoded.height,
    data: decoded.data instanceof Uint8Array ? decoded.data : new Uint8Array(decoded.data),
  };
}

/**
 * 最近邻缩放（纯 JS，测试与兜底用）。
 *
 * <p>正常路径上缩放是原生做的（`expo-image-manipulator`），这里只在
 * 「需要把像素放到补边后的画布上」以及单测里用——最近邻对二值化的文字来说够用。
 */
export function resizeNearest(image: RgbaImage, width: number, height: number): RgbaImage {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      const from = (sourceY * image.width + sourceX) * 4;
      const to = (y * width + x) * 4;
      out[to] = image.data[from]!;
      out[to + 1] = image.data[from + 1]!;
      out[to + 2] = image.data[from + 2]!;
      out[to + 3] = image.data[from + 3]!;
    }
  }
  return { width, height, data: out };
}

/**
 * 原地旋转 180°（水平 + 垂直翻转）。
 *
 * <p>方向分类头认出「这行是倒着的」之后，用它把那块文字转正再送进识别头；
 * 纯 JS 翻转比再调一次原生裁剪便宜得多，而且不需要把整张原图重新读一遍。
 */
export function rotate180(image: RgbaImage): RgbaImage {
  const { width, height, data } = image;
  const out = new Uint8Array(data.length);
  const last = width * height - 1;
  for (let i = 0; i <= last; i += 1) {
    const from = i * 4;
    const to = (last - i) * 4;
    out[to] = data[from]!;
    out[to + 1] = data[from + 1]!;
    out[to + 2] = data[from + 2]!;
    out[to + 3] = data[from + 3]!;
  }
  return { width, height, data: out };
}

/**
 * 把图片放进一块更大的画布（右下角补零），用于把检测输入补到 32 的倍数。
 *
 * <p>补的是 **0（黑色）** 而不是灰：DB 的概率图在纯黑区域自然接近 0，不会凭空造出文字框。
 */
export function padToCanvas(
  image: RgbaImage,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
): RgbaImage {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < image.height; y += 1) {
    const targetY = y + offsetY;
    if (targetY < 0 || targetY >= height) {
      continue;
    }
    for (let x = 0; x < image.width; x += 1) {
      const targetX = x + offsetX;
      if (targetX < 0 || targetX >= width) {
        continue;
      }
      const from = (y * image.width + x) * 4;
      const to = (targetY * width + targetX) * 4;
      out[to] = image.data[from]!;
      out[to + 1] = image.data[from + 1]!;
      out[to + 2] = image.data[from + 2]!;
      out[to + 3] = image.data[from + 3]!;
    }
  }
  return { width, height, data: out };
}

/**
 * RGBA → NCHW 的 Float32 张量（`[1, 3, H, W]`），并做归一化。
 *
 * <p>PP-OCR 的输入顺序是 **RGB**，而 JPEG 解出来是 RGBA，所以这里顺手丢掉 alpha；
 * 通道顺序搞反（BGR）不会报错，只会让识别率掉一截，是这类集成的经典坑。
 */
export function toChwTensor(
  image: RgbaImage,
  mean: [number, number, number],
  std: [number, number, number],
  order: ChannelOrder = 'rgb',
): Float32Array {
  const { width, height, data } = image;
  const tensor = new Float32Array(3 * width * height);
  const plane = width * height;
  // JPEG 解出来是 RGBA，前三个字节就是 R/G/B（不是 BGR）——别照抄 cv2 那套顺序
  const swap = order === 'bgr';
  for (let i = 0; i < plane; i += 1) {
    const base = i * 4;
    const r = (data[base] ?? 0) / 255;
    const g = (data[base + 1] ?? 0) / 255;
    const b = (data[base + 2] ?? 0) / 255;
    tensor[i] = ((swap ? b : r) - mean[0]) / std[0];
    tensor[plane + i] = (g - mean[1]) / std[1];
    tensor[plane * 2 + i] = ((swap ? r : b) - mean[2]) / std[2];
  }
  return tensor;
}
