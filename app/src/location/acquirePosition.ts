/**
 * 「取一次当前位置」的来源选择（纯逻辑，可在 node 里单测）。
 *
 * <p>三条来源，按这个顺序退化：
 * <ol>
 *   <li>**系统定位**（`systemLocation.ts` 背后的原生模块）：不依赖 GMS，华为等机型唯一的正解；</li>
 *   <li>**expo-location**：老 APK（没有新模块）与 iOS 上仍然走它。
 *       注意它在没有 Google 服务的 Android 机型上会失败，所以只能当兜底；</li>
 *   <li>都没有 / 全失败 → 抛错，由页面给出「直接搜索地点」的提示，绝不假装定位成功。</li>
 * </ol>
 *
 * <p>为什么不在这里直接 import 两者：本文件要求能在 vitest 里跑，
 * 而 `expo-location` / `react-native` 的原生件在 node 里没有实现。
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface PositionSource {
  /** 当前构建里有没有可用的系统定位模块 */
  systemAvailable: () => boolean;
  /** 系统定位取一次位置 */
  fromSystem: (timeoutMs: number) => Promise<Coordinates>;
  /** expo-location 取一次位置（含它自己的「上次已知位置」兜底） */
  fromFallback: () => Promise<Coordinates>;
}

/**
 * @param timeoutMs 系统定位的等待上限
 * @throws 两条来源都拿不到时抛错（错误信息面向开发者，页面会换成用户能懂的一句话）
 */
export async function acquirePosition(
  source: PositionSource,
  timeoutMs: number,
): Promise<Coordinates> {
  if (!source.systemAvailable()) {
    // 老 APK / iOS：只有 expo-location 可用（iOS 上它本来就是好的）
    return source.fromFallback();
  }
  try {
    return await source.fromSystem(timeoutMs);
  } catch (systemError) {
    /*
     * 系统定位失败（定位服务没开、室内无信号…）时再给 expo 一次机会：
     * 在有 GMS 的机器上它能拿到「上次已知位置」，比彻底失败强。
     * 没有 GMS 的机器上这一步也会失败 —— 那就如实抛错，绝不编一个坐标出来。
     */
    try {
      return await source.fromFallback();
    } catch {
      throw systemError;
    }
  }
}
