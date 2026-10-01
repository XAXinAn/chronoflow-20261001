/**
 * PP-OCR 检测头（DB, Differentiable Binarization）的后处理。
 *
 * <p>模型给出的是 `[1, 1, H, W]` 的概率图（0..1）。要得到「哪几块是文字」，得走：
 * **二值化 → 连通域 → 每块取外接矩形 → 过滤（分数太低 / 太小）→ unclip 外扩 → 映射回原图**。
 *
 * <p>这几步都在纯逻辑里做，因此可以离线单测——它是整条流水线里最容易「看起来对、
 * 实际把文字切掉一半」的一环：漏了 unclip 的话，识别出来会**缺首尾字**；
 * 忘了映射回原图的话，裁出来的框会偏到别的行去。
 *
 * <p>与官方实现的取舍：官方用 pyclipper 在多边形上做 offset。这里是移动端一次性识别，
 * 连通域给的本就是轴对齐矩形，所以用等价的近似公式外扩（见 {@link unclipRect}），
 * 省掉一个图像几何库。
 */

/** 检测概率图的二值化阈值（官方 `det_db_thresh` 默认 0.3）。 */
export const DET_BIN_THRESHOLD = 0.3;
/** 每块文字的平均分下限（官方 `det_db_box_thresh` 默认 0.6）。 */
export const DET_BOX_THRESHOLD = 0.6;
/** 外扩比例（官方 `det_db_unclip_ratio` 默认 1.5）。 */
export const DET_UNCLIP_RATIO = 1.5;
/** 小于这个边长的块直接丢掉（噪点）。 */
export const DET_MIN_SIZE = 3;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 检测出来的一个文本框（坐标在**检测输入图**上）。 */
export interface DetBox extends Rect {
  /** 该块的平均概率，用于排序与调试 */
  score: number;
}

/**
 * 检测输入图的缩放方案：先等比缩放到最长边不超过 `limit`，再补边到 `stride` 的整数倍。
 *
 * <p>补边是必须的：DB 的骨干网络要下采样 32 倍，输入尺寸不是 32 的倍数时最后的特征图
 * 会对不齐，概率图整体偏一点——表现就是框整体斜着漂。
 */
export interface DetPlan {
  scale: number;
  inputWidth: number;
  inputHeight: number;
  /** 左边 / 上边补了多少像素（识别框映射回原图时要减掉） */
  padX: number;
  padY: number;
}

export function planDetInput(
  imageWidth: number,
  imageHeight: number,
  limit: number,
  stride: number,
): DetPlan {
  const scale = Math.min(1, limit / Math.max(imageWidth, imageHeight));
  const scaledWidth = Math.round(imageWidth * scale);
  const scaledHeight = Math.round(imageHeight * scale);
  const inputWidth = Math.ceil(scaledWidth / stride) * stride;
  const inputHeight = Math.ceil(scaledHeight / stride) * stride;
  return {
    scale,
    inputWidth,
    inputHeight,
    padX: Math.floor((inputWidth - scaledWidth) / 2),
    padY: Math.floor((inputHeight - scaledHeight) / 2),
  };
}

/** 概率图 → 0/1 掩码。 */
export function binarize(
  scores: ArrayLike<number>,
  height: number,
  width: number,
  threshold = DET_BIN_THRESHOLD,
): Uint8Array {
  const mask = new Uint8Array(height * width);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = (scores[i] ?? 0) >= threshold ? 1 : 0;
  }
  return mask;
}

/**
 * 四连通域标记（迭代式，不用递归——一张 960×960 的图递归下去会爆栈）。
 *
 * <p>返回每块的边界框与平均分；平均分要在**概率图**上取（不是二值图），
 * 否则「一整块都是 0.31」和「一整块都是 0.99」会被当成一样可信。
 */
export function connectedComponents(
  mask: Uint8Array,
  scores: ArrayLike<number>,
  height: number,
  width: number,
): DetBox[] {
  const visited = new Uint8Array(mask.length);
  const boxes: DetBox[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || visited[start] === 1) {
      continue;
    }
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    let scoreSum = 0;

    while (stack.length > 0) {
      const index = stack.pop() as number;
      const x = index % width;
      const y = (index - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      count += 1;
      scoreSum += scores[index] ?? 0;

      // 四连通：上下左右
      if (x > 0) pushIfUnvisited(index - 1);
      if (x + 1 < width) pushIfUnvisited(index + 1);
      if (y > 0) pushIfUnvisited(index - width);
      if (y + 1 < height) pushIfUnvisited(index + width);
    }

    boxes.push({
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      score: count > 0 ? scoreSum / count : 0,
    });

    function pushIfUnvisited(next: number) {
      if (mask[next] === 1 && visited[next] === 0) {
        visited[next] = 1;
        stack.push(next);
      }
    }
  }

  return boxes;
}

/** 丢掉噪声块：分数太低、或者尺寸小到不可能是文字。 */
export function filterBoxes(
  boxes: DetBox[],
  boxThreshold = DET_BOX_THRESHOLD,
  minSize = DET_MIN_SIZE,
): DetBox[] {
  return boxes.filter(
    (box) => box.score >= boxThreshold && box.width >= minSize && box.height >= minSize,
  );
}

/**
 * 外扩一个轴对齐矩形（对应官方的 `unclip`）。
 *
 * <p>DB 的输出本来就比文字**小一圈**（收缩过的），不外扩的话首尾笔画会被切掉，
 * 识别结果就会缺字。官方的距离公式是 `area * ratio / perimeter`，对矩形化简后
 * 每边外扩 `(w * h * ratio) / (2 * (w + h))`。
 */
export function unclipRect(
  box: Rect,
  ratio = DET_UNCLIP_RATIO,
  bounds?: { width: number; height: number },
): Rect {
  const distance = (box.width * box.height * ratio) / (2 * (box.width + box.height));
  const x = box.x - distance;
  const y = box.y - distance;
  const width = box.width + distance * 2;
  const height = box.height + distance * 2;
  if (!bounds) {
    return { x, y, width, height };
  }
  // 夹回图片范围；夹过之后仍然保证 width/height > 0（裁剪器不接受空框）
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.min(width, bounds.width - left)),
    height: Math.max(1, Math.min(height, bounds.height - top)),
  };
}

/** 检测输入图上的框 → 原图坐标（先减补边、再除以缩放）。 */
export function mapBoxToImage(box: Rect, plan: DetPlan): Rect {
  return {
    x: (box.x - plan.padX) / plan.scale,
    y: (box.y - plan.padY) / plan.scale,
    width: box.width / plan.scale,
    height: box.height / plan.scale,
  };
}

/**
 * 阅读顺序：先按行的中心 y 从上到下，同一行内按 x 从左到右。
 *
 * <p>不排序的话，识别出来的文字会按「连通域发现的顺序」拼，通知类的多行文本就成了一团乱码，
 * 后面的会话模型也就抽不出事情了。同一行的判定用高度的一半做阈值（一行的高度容差）。
 */
export function orderBoxes(boxes: Rect[]): Rect[] {
  return [...boxes].sort((left, right) => {
    const leftCenter = left.y + left.height / 2;
    const rightCenter = right.y + right.height / 2;
    const tolerance = Math.min(left.height, right.height) / 2;
    if (Math.abs(leftCenter - rightCenter) > tolerance) {
      return leftCenter - rightCenter;
    }
    return left.x - right.x;
  });
}
