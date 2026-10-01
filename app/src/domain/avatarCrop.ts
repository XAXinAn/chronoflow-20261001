/**
 * 头像裁剪的纯计算（spec §4.1.8）。
 *
 * <p>用户反馈：非 1:1 的图片直接当头像，会被圆形容器裁掉两边（人脸经常只剩一半）。
 * 所以选完图先给一个**正方形取景框**：拖拽移动、双指缩放，确认后按取景框裁成 1:1。
 *
 * <p>这里只算「图片在取景框里怎么摆」「该按原图的哪块矩形去裁」，不碰任何原生 API
 * —— 于是可以在 node 里单测。三个必须守住的约束：
 *   1. 图片**始终盖满**取景框（露边就是一条空白，用户一眼看出这是 bug）；
 *   2. 缩放只能是放大（`scale ≥ 1`），否则会出现「整张图缩成一个小方块」；
 *   3. 裁剪矩形必须落在原图范围内，且长宽都 > 0（否则 ImageManipulator 直接报错）。
 */

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * 图片在取景框里的摆放。
 *
 * - `scale`：在「铺满取景框」之上的额外放大倍数，1 = 刚好铺满；
 * - `offsetX` / `offsetY`：图片中心相对取景框中心的位移（像素）。
 */
export interface CropTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface CropRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/** 最多放大到「铺满」的 4 倍：再大人眼看不出差别，手指也不够精细。 */
export const MAX_AVATAR_ZOOM = 4;

/** 铺满取景框所需的基础缩放（cover 语义：取长边，短边溢出）。 */
export function coverScale(image: ImageSize, viewport: number): number {
  if (image.width <= 0 || image.height <= 0 || viewport <= 0) {
    return 1;
  }
  return Math.max(viewport / image.width, viewport / image.height);
}

/**
 * 初始摆放：铺满 + 居中。
 *
 * <p>参数只为把「和尺寸有关」这件事写进签名里（调用方也必须先拿到尺寸才敢建取景框）；
 * 居中本身与尺寸无关，所以这里是常量。
 */
export function initialTransform(_image: ImageSize, _viewport: number): CropTransform {
  return { scale: 1, offsetX: 0, offsetY: 0 };
}

/** 当前实际渲染尺寸（图片按这个尺寸画在取景框里）。 */
export function renderedSize(
  image: ImageSize,
  viewport: number,
  transform: CropTransform,
): ImageSize {
  const base = coverScale(image, viewport);
  return {
    width: image.width * base * transform.scale,
    height: image.height * base * transform.scale,
  };
}

/**
 * 夹住位移 / 缩放：保证图片一直盖满取景框。
 *
 * <p>缩小时（例如从 3 倍退回 1 倍）也要重新夹一次位移——不夹的话，之前拖到边上的图
 * 缩回去就会露出空白边。
 */
export function clampTransform(
  image: ImageSize,
  viewport: number,
  transform: CropTransform,
): CropTransform {
  const scale = Math.min(Math.max(transform.scale, 1), MAX_AVATAR_ZOOM);
  const size = renderedSize(image, viewport, { ...transform, scale });
  const maxX = Math.max(0, (size.width - viewport) / 2);
  const maxY = Math.max(0, (size.height - viewport) / 2);
  return {
    scale,
    offsetX: Math.min(Math.max(transform.offsetX, -maxX), maxX),
    offsetY: Math.min(Math.max(transform.offsetY, -maxY), maxY),
  };
}

/**
 * 取景框对应原图的哪块矩形 —— 这是最终交给裁剪器的东西。
 *
 * <p>坐标系：取景框左上角是 (0,0)，边长 `viewport`；图片左上角的显示坐标是
 * `(viewport - width) / 2 + offsetX`（`width` 是渲染宽度）。
 */
export function cropRect(
  image: ImageSize,
  viewport: number,
  transform: CropTransform,
): CropRect {
  const safe = clampTransform(image, viewport, transform);
  const size = renderedSize(image, viewport, safe);
  const imageLeft = (viewport - size.width) / 2 + safe.offsetX;
  const imageTop = (viewport - size.height) / 2 + safe.offsetY;
  const originX = (0 - imageLeft) / size.width * image.width;
  const originY = (0 - imageTop) / size.height * image.height;
  const width = viewport / size.width * image.width;
  const height = viewport / size.height * image.height;

  // 亚像素误差可能让矩形溢出一两个像素，夹回原图范围内（宽高按溢出量同步收）
  const x = Math.min(Math.max(originX, 0), Math.max(0, image.width - 1));
  const y = Math.min(Math.max(originY, 0), Math.max(0, image.height - 1));
  return {
    originX: x,
    originY: y,
    width: Math.min(width, image.width - x),
    height: Math.min(height, image.height - y),
  };
}

/** 双指距离 → 缩放倍数；手指没动（起始距离为 0）时保持原样。 */
export function scaleFromPinch(startScale: number, startDistance: number, distance: number): number {
  if (startDistance <= 0) {
    return startScale;
  }
  return Math.min(Math.max(startScale * (distance / startDistance), 1), MAX_AVATAR_ZOOM);
}

/** 两指之间的距离（勾股定理），用于捏合缩放。 */
export function touchDistance(
  first: { pageX: number; pageY: number },
  second: { pageX: number; pageY: number },
): number {
  return Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY);
}
