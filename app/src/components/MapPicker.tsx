import { useEffect, useImperativeHandle, useState, type Ref } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { useAppTheme, useRuntime } from '../context/AppContext';

/** 命令式接口：确认时要主动向地图索取中心点。 */
export interface MapPickerHandle {
  getCenter: () => void;
}

/** 要让地图飞过去的点。version 变化即触发一次，便于「同一个点再选一次」。 */
export interface MapFocus {
  version: number;
  latitude: number;
  longitude: number;
}

/** 设备当前定位（WGS-84）。页面内会转成 GCJ-02 再落点。 */
export type MapLocate = MapFocus;

/**
 * `sdk`    = 高德 SDK 已就绪，可以接收指令（此时还没有地图）
 * `mapped` = 地图已按第一个位置建好，可以拖动了
 */
export type MapPhase = 'loading' | 'sdk' | 'mapped' | 'error';

/**
 * 地图选点。
 *
 * 为什么是 WebView 而不是原生地图：App 跑在 Expo Go 里，`react-native-maps`
 * 这类原生模块装不进来（要自定义 Dev Client）。`react-native-webview` 是 Expo Go
 * 内置的，加载高德 JS 地图即可拿到可拖拽的真实地图，且不用换客户端。
 *
 * 页面**由后端提供**（`/map/amap`）而不是本地内联 HTML：内联走 Android 的
 * loadDataWithBaseURL，高德 v2 在这种伪文档里下得到脚本却不会定义 AMap。
 * 走真实 HTTP 页面才正常，而且 Key 始终由服务端注入。
 *
 * 交互是「地图动、图钉不动」：图钉固定在屏幕中心，拖动地图即移动选址点，
 * 单手操作比拖图钉准，也不会误触。
 */
export function MapPicker({
  ref,
  focus,
  locate,
  onCenterChanged,
  onCenterRequested,
  onPhaseChange,
}: {
  ref?: Ref<MapPickerHandle>;
  focus: MapFocus | null;
  locate: MapLocate | null;
  /** 拖动结束后回报当前中心点，供端上实时反查地址 */
  onCenterChanged: (latitude: number, longitude: number) => void;
  /** 端上索取中心点时的回执 */
  onCenterRequested: (latitude: number, longitude: number) => void;
  onPhaseChange: (phase: MapPhase, message?: string) => void;
}) {
  const theme = useAppTheme();
  const { baseUrl } = useRuntime();
  const [webRef, setWebRef] = useState<WebView | null>(null);
  const [phase, setPhase] = useState<MapPhase>('loading');
  const [errorText, setErrorText] = useState<string | null>(null);

  // 用 ref 回调而不是 useRef：这里既要 imperative 地发消息，
  // 又要在拿到实例后立刻同步一次 focus。
  useEffect(() => {
    if (!webRef || !focus) {
      return;
    }
    webRef.postMessage(JSON.stringify({
      type: 'setCenter',
      latitude: focus.latitude,
      longitude: focus.longitude,
    }));
  }, [webRef, focus?.version, focus?.latitude, focus?.longitude]);

  // 定位单独走一条命令：坐标是 GPS 原始值，转换必须在页面里用 SDK 做
  useEffect(() => {
    if (!webRef || !locate) {
      return;
    }
    webRef.postMessage(JSON.stringify({
      type: 'locate',
      latitude: locate.latitude,
      longitude: locate.longitude,
    }));
  }, [webRef, locate?.version, locate?.latitude, locate?.longitude]);

  // React 19 起 ref 可以直接作为 prop 传入，不必再包 forwardRef
  useImperativeHandle(
    ref,
    () => ({
      getCenter: () => webRef?.postMessage(JSON.stringify({ type: 'getCenter' })),
    }),
    [webRef],
  );

  const uri = `${baseUrl}/map/amap`;

  const handleMessage = (event: WebViewMessageEvent) => {
    let payload: { type?: string; message?: string; latitude?: number; longitude?: number };
    try {
      payload = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (payload.type === 'sdk') {
      setPhase('sdk');
      onPhaseChange('sdk');
      return;
    }
    if (payload.type === 'ready') {
      setPhase('mapped');
      onPhaseChange('mapped');
      return;
    }
    if (payload.type === 'error') {
      setPhase('error');
      setErrorText(payload.message ?? '地图加载失败');
      onPhaseChange('error', payload.message);
      return;
    }
    if (typeof payload.latitude !== 'number' || typeof payload.longitude !== 'number') {
      return;
    }
    if (payload.type === 'moved') {
      onCenterChanged(payload.latitude, payload.longitude);
      return;
    }
    if (payload.type === 'center') {
      onCenterRequested(payload.latitude, payload.longitude);
    }
  };

  return (
    <View style={[styles.mapBox, { borderColor: theme.color.border }]}>
      <WebView
        ref={setWebRef}
        originWhitelist={['*']}
        source={{ uri }}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        style={{ flex: 1, backgroundColor: theme.color.surface }}
      />

      {/* 图钉固定在屏幕中心，动的是地图 */}
      <View pointerEvents="none" style={styles.pin}>
        <View
          style={[styles.pinDot, { backgroundColor: theme.color.accent, borderColor: theme.color.surfaceRaised }]}
        />
        <View style={[styles.pinStem, { backgroundColor: theme.color.accent }]} />
      </View>

      {/* 加载态交给页面自己显示（「正在定位…」），这里只兜错误，
          否则两层文字会叠在一起 */}
      {phase === 'error' ? (
        <View style={styles.overlay}>
          <Text style={{ color: theme.color.danger, fontSize: 13, textAlign: 'center', paddingHorizontal: 24 }}>
            {errorText}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  mapBox: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  pin: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 3 },
  pinStem: { width: 2, height: 16 },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
});
