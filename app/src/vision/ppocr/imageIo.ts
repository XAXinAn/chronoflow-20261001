/**
 * 「取像素」里**碰原生 API** 的那一半。
 *
 * <p>刻意与 `pixels.ts` 分开：那边是纯计算（base64、解码、缩放、补边、归一化），
 * 可以在 node 里单测；这边要 `expo-image-manipulator`（原生模块），一 import 就把
 * vitest 带进原生依赖里。这条线在本仓是硬约定——`src/domain/**` 只放纯逻辑，
 * 原生适配层单独一层（见 AGENTS §7「纯逻辑测试不能代替真实运行」的另一面：
 * 也别让原生依赖污染纯逻辑测试）。
 */

import { SaveFormat, manipulateAsync } from 'expo-image-manipulator';

import { base64ToBytes, decodeJpegBytes, type RgbaImage } from './pixels';

/**
 * 把图片缩到指定尺寸并解码成像素。
 *
 * <p>失败一律抛出去：调用方（`pipeline`）会如实说「识别失败」，
 * 不在这里悄悄返回一张空图——空图会让检测输出 0 个框，看起来像「这张图没有字」。
 *
 * <p>输出格式固定 JPEG：它比 PNG 小、解码也快（`jpeg-js` 是纯 JS，太大就慢）。
 */
export async function readScaledRgba(
  uri: string,
  target: { width?: number; height?: number },
): Promise<RgbaImage> {
  const result = await manipulateAsync(uri, [{ resize: target }], {
    compress: 1,
    format: SaveFormat.JPEG,
    base64: true,
  });
  if (!result.base64) {
    throw new Error('图片解码失败（没有拿到像素数据）');
  }
  return decodeJpegBytes(base64ToBytes(result.base64));
}

/** 从原图上裁一块并缩放（识别每个文本框时用）。 */
export async function readCroppedRgba(
  uri: string,
  crop: { originX: number; originY: number; width: number; height: number },
  target: { width?: number; height?: number },
): Promise<RgbaImage> {
  const result = await manipulateAsync(uri, [{ crop }, { resize: target }], {
    compress: 1,
    format: SaveFormat.JPEG,
    base64: true,
  });
  if (!result.base64) {
    throw new Error('图片裁剪失败（没有拿到像素数据）');
  }
  return decodeJpegBytes(base64ToBytes(result.base64));
}

/** 只取原图尺寸（检测输入规划要用）。 */
export async function readImageSize(uri: string): Promise<{ width: number; height: number }> {
  // 用一次「缩放到 1 像素」问出尺寸太浪费；manipulateAsync 带 metadata 的能力在
  // expo-image-manipulator 里没有，所以这里用一个极小的 resize 也不合适 ——
  // 调用方手里一般已经有尺寸（`Image.getSize` / 选图结果），真缺了就用这个兜底。
  const { Image } = await import('react-native');
  return new Promise((resolve, reject) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      () => reject(new Error('读不出这张图片的尺寸')),
    );
  });
}
