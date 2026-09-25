import type { Endpoints } from '../api/endpoints';
import { applyResolvedPlace, type RecognizedEventDraft } from '../domain/vision';

/**
 * 拍照 / 相册识别日程（spec §4.1.9）。
 *
 * <p>**端侧优先，服务端兜底**：
 * 1. 端侧（Dev Client 构建）：图片不出设备，用本地轻量多模态模型识别；
 * 2. 端侧不可用时（Expo Go、模型没下载、内存不足）回落到服务端 `/ai/events/recognize`；
 * 3. 两边都不可用就明确报错，给「手动新建」的兜底——不假装识别成功。
 *
 * <p>`source` 会如实告诉用户「这次是在手机上识别的」还是「发到服务器识别的」：
 * 照片的去向属于用户应该知道的事。
 */

export type RecognitionSource = 'device' | 'server';

export interface RecognitionResult {
  source: RecognitionSource;
  provider: string;
  /** 服务端识别时会落盘，带回相对 URL；端侧识别没有这一步 */
  imageUrl: string | null;
  items: RecognizedEventDraft[];
  /** 端侧失败的原因（用于提示为什么走了服务端），没有就是 null */
  deviceFallbackReason: string | null;
}

/**
 * 给识别出的地名做一次**高德解析**（spec §4.1.9 × §5.9）。
 *
 * <p>模型给的是文本（「A座3F报告厅」），能不能导航取决于地图服务认不认。
 * 认不出就留空——一段谁也没法定位的自由文本，进了日历只会误导用户。
 * 解析失败的条目**不丢弃**，用户可以在结果页手动选地点。
 */
export async function resolveDraftPlaces(
  drafts: RecognizedEventDraft[],
  api: Endpoints,
): Promise<RecognizedEventDraft[]> {
  return Promise.all(
    drafts.map(async (draft) => {
      const keyword = draft.locationName?.trim();
      if (!keyword) {
        return draft;
      }
      try {
        const places = await api.geoPlaces(keyword);
        const best = places[0];
        return applyResolvedPlace(
          draft,
          best
            ? {
                name: best.name,
                address: best.address ?? null,
                latitude: best.latitude,
                longitude: best.longitude,
                poiId: best.poiId ?? null,
              }
            : null,
        );
      } catch {
        // 地点服务不可用（含未配置 Key 的降级态）：同样按「没匹配上」处理并留空
        return applyResolvedPlace(draft, null);
      }
    }),
  );
}

/** 端侧模型不可用（没装 Dev Client、模型没下载等）。 */
export class DeviceRecognitionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceRecognitionUnavailable';
  }
}

export async function recognizePhoto(options: {
  uri: string;
  api: Endpoints;
  /** 关闭端侧、强制走服务端（排查用，也便于在 Expo Go 里验证服务端链路） */
  preferDevice?: boolean;
}): Promise<RecognitionResult> {
  const preferDevice = options.preferDevice ?? true;
  let fallbackReason: string | null = null;

  if (preferDevice) {
    try {
      // 动态 import：Expo Go 里没有这个原生模块，静态 import 会让整个包加载失败
      const onDevice = await import('./onDevice');
      const items = await onDevice.recognizeOnDevice(options.uri);
      return {
        source: 'device',
        provider: onDevice.describeModel(),
        imageUrl: null,
        items,
        deviceFallbackReason: null,
      };
    } catch (cause) {
      fallbackReason = cause instanceof Error ? cause.message : String(cause);
    }
  }

  const remote = await options.api.recognizeEvents(options.uri);
  return {
    source: 'server',
    provider: remote.provider,
    imageUrl: remote.imageUrl,
    items: remote.items,
    deviceFallbackReason: fallbackReason,
  };
}
