import { NativeModules, Platform } from 'react-native';

/**
 * 自带的系统定位模块的 JS 入口（原生实现见 `app/plugins/withSystemLocation.js`）。
 *
 * <p>**为什么需要它**：`expo-location` 的 Android 实现只用 GMS 融合定位，
 * 华为等没有 Google 服务的机型上取位置必然失败（真机反馈：华为 Mate 70「授权后定位仍失败」）。
 * 这个模块直读 Android 框架的 `LocationManager`，不依赖 GMS。
 *
 * <p>两条纪律，都来自这个项目踩过的坑：
 * <ol>
 *   <li>**先判存在再取用**：模块缺失时 `NativeModules.X` 是 undefined，
 *       直接调它会抛异常；在 release 包里模块加载期的异常是致命的（见 AGENTS 第二十轮）。</li>
 *   <li>**只做适配、不做决策**：挑哪个来源、失败怎么办写在 `acquirePosition` 里，
 *       那是纯逻辑、能在 node 里单测；这个文件里只有「调用原生」这一件事。</li>
 * </ol>
 */

export interface SystemPosition {
  latitude: number;
  longitude: number;
  accuracy?: number;
  provider?: string | null;
  timestamp?: number;
}

interface NativeSystemLocationModule {
  getCurrentPosition(timeoutMs: number): Promise<SystemPosition>;
}

function nativeModule(): NativeSystemLocationModule | null {
  // iOS 侧不注入这个模块（那边 CoreLocation 本来就是好的），所以只在 Android 上认它
  if (Platform.OS !== 'android') {
    return null;
  }
  const module = (NativeModules as Record<string, unknown>).ChronoflowLocation;
  if (!module || typeof (module as NativeSystemLocationModule).getCurrentPosition !== 'function') {
    return null;
  }
  return module as NativeSystemLocationModule;
}

/** 这个构建里有没有系统定位模块（老版本 APK / Web 预览里没有）。 */
export function systemLocationAvailable(): boolean {
  return nativeModule() !== null;
}

/** 取一次当前位置。模块不存在或坐标非法都抛错，由调用方决定降级。 */
export async function getSystemPosition(timeoutMs: number): Promise<SystemPosition> {
  const module = nativeModule();
  if (!module) {
    throw new Error('系统定位模块不可用');
  }
  const position = await module.getCurrentPosition(timeoutMs);
  if (
    !position ||
    typeof position.latitude !== 'number' ||
    typeof position.longitude !== 'number' ||
    Number.isNaN(position.latitude) ||
    Number.isNaN(position.longitude)
  ) {
    throw new Error('系统定位没有返回有效坐标');
  }
  return position;
}
