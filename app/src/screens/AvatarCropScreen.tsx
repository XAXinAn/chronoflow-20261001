import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, PanResponder, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SaveFormat, manipulateAsync } from 'expo-image-manipulator';

import { Screen } from '../components/ui';
import { EditorHeader } from '../components/form';
import { useAppTheme } from '../context/AppContext';
import {
  MAX_AVATAR_ZOOM,
  clampTransform,
  cropRect,
  initialTransform,
  renderedSize,
  scaleFromPinch,
  touchDistance,
  type CropTransform,
  type ImageSize,
} from '../domain/avatarCrop';

/** 裁剪结果的最长边：头像在界面上只有 64pt，存 512 已经绰绰有余。 */
const OUTPUT_SIZE = 512;

/**
 * 头像取景（spec §4.1.8）。
 *
 * <p>真机反馈：非 1:1 的照片直接当头像，会被圆形框裁掉两边（人脸经常只剩一半）。
 * 所以选完图先在这里给一个**正方形取景框**：单指拖动移动图片、双指捏合缩放，
 * 确认后按取景框裁成 1:1 再上传。
 *
 * <p>手势用 `PanResponder` 挂在**普通 View** 上（不是 `Pressable`）——`Pressable` 内部的
 * Pressability 会把 `onStartShouldSetResponder` 等展开在后面，把手势整块盖掉（语音按钮
 * 就栽在这上面）。几何计算全在 `domain/avatarCrop.ts`，这里只做手势与渲染。
 */
export function AvatarCropScreen({
  uri,
  onCancel,
  onDone,
}: {
  uri: string;
  onCancel: () => void;
  /** 裁好的本地文件 uri（还没上传，上传由「我的」页负责） */
  onDone: (croppedUri: string) => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();

  const [image, setImage] = useState<ImageSize | null>(null);
  const [transform, setTransform] = useState<CropTransform>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 取景框边长：跟随屏幕宽度，留出左右边距，最宽 360（平板/横屏上不成巨框）。 */
  const viewport = Math.min(window.width - theme.spacing.md * 2, 360);

  const imageRef = useRef<ImageSize | null>(null);
  const viewportRef = useRef(viewport);
  const transformRef = useRef(transform);
  viewportRef.current = viewport;

  /** 一次手势的基准：切换「拖动 ↔ 捏合」时要重新取基准，否则会出现跳变。 */
  const gestureRef = useRef({
    mode: 'none' as 'none' | 'pan' | 'pinch',
    startDx: 0,
    startDy: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    startDistance: 0,
    startScale: 1,
  });

  const commit = useCallback((next: CropTransform) => {
    const current = imageRef.current;
    if (!current) {
      return;
    }
    // 夹一次再落地：图片永远盖满取景框（露白就是 bug）
    const clamped = clampTransform(current, viewportRef.current, next);
    transformRef.current = clamped;
    setTransform(clamped);
  }, []);

  useEffect(() => {
    let active = true;
    Image.getSize(
      uri,
      (width, height) => {
        if (!active) {
          return;
        }
        imageRef.current = { width, height };
        setImage({ width, height });
        commit(initialTransform({ width, height }, viewportRef.current));
      },
      () => {
        if (active) {
          setError('读不出这张图片的尺寸，换一张试试');
        }
      },
    );
    return () => {
      active = false;
    };
  }, [commit, uri]);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        gestureRef.current.mode = 'none';
      },
      onPanResponderMove: (event, gesture) => {
        if (!imageRef.current) {
          return;
        }
        const touches = event.nativeEvent.touches;
        const state = gestureRef.current;
        if (touches.length >= 2) {
          const distance = touchDistance(touches[0]!, touches[1]!);
          if (state.mode !== 'pinch') {
            state.mode = 'pinch';
            state.startDistance = distance;
            state.startScale = transformRef.current.scale;
          }
          commit({
            ...transformRef.current,
            scale: scaleFromPinch(state.startScale, state.startDistance, distance),
          });
          return;
        }
        if (state.mode !== 'pan') {
          state.mode = 'pan';
          state.startDx = gesture.dx;
          state.startDy = gesture.dy;
          state.startOffsetX = transformRef.current.offsetX;
          state.startOffsetY = transformRef.current.offsetY;
        }
        commit({
          ...transformRef.current,
          offsetX: state.startOffsetX + (gesture.dx - state.startDx),
          offsetY: state.startOffsetY + (gesture.dy - state.startDy),
        });
      },
      onPanResponderRelease: () => {
        gestureRef.current.mode = 'none';
      },
      onPanResponderTerminate: () => {
        gestureRef.current.mode = 'none';
      },
    }),
  ).current;

  const use = async () => {
    const current = imageRef.current;
    if (!current || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const rect = cropRect(current, viewportRef.current, transformRef.current);
      const actions = rect.width > OUTPUT_SIZE
        ? [{ crop: rect }, { resize: { width: OUTPUT_SIZE } }]
        : [{ crop: rect }];
      const result = await manipulateAsync(uri, actions, {
        compress: 0.9,
        format: SaveFormat.JPEG,
      });
      onDone(result.uri);
    } catch {
      setError('裁剪失败，请换一张图片试试');
    } finally {
      setBusy(false);
    }
  };

  const shown = image ? renderedSize(image, viewport, transform) : null;

  return (
    <Screen>
      <EditorHeader
        title="调整头像"
        onCancel={onCancel}
        onSave={() => void use()}
        saveLabel="使用"
        saving={busy}
        savingLabel="处理中…"
        saveDisabled={!image}
      />

      <View style={[styles.body, { paddingTop: theme.spacing.lg }]}>
        <View
          {...responder.panHandlers}
          accessibilityLabel="头像取景框，单指拖动调整位置，双指缩放"
          style={[
            styles.viewport,
            {
              width: viewport,
              height: viewport,
              borderRadius: theme.radius.card,
              backgroundColor: theme.color.surface,
              borderColor: theme.color.border,
            },
          ]}
        >
          {shown && image ? (
            <Image
              source={{ uri }}
              style={{
                width: shown.width,
                height: shown.height,
                transform: [{ translateX: transform.offsetX }, { translateY: transform.offsetY }],
              }}
              resizeMode="cover"
            />
          ) : null}
          {/* 圆形参考线：头像最终就是圆的，取景时就按圆看 */}
          <View
            pointerEvents="none"
            style={[
              styles.circle,
              {
                width: viewport * 0.92,
                height: viewport * 0.92,
                borderRadius: viewport * 0.46,
                borderColor: theme.color.accentContrast,
              },
            ]}
          />
        </View>

        <Text
          style={{
            color: theme.color.textSecondary,
            fontSize: 13,
            marginTop: theme.spacing.md,
            textAlign: 'center',
          }}
        >
          拖动调整位置，双指缩放（最多放大约 {MAX_AVATAR_ZOOM} 倍）
        </Text>
        <Text
          style={{
            color: theme.color.textTertiary,
            fontSize: 12,
            marginTop: 6,
            textAlign: 'center',
          }}
        >
          圆圈里是最终看到的头像区域
        </Text>

        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.md }}>
            {error}
          </Text>
        ) : null}
      </View>

      {/* 底部留白：避免取景框在矮屏上顶到安全区 */}
      <View style={{ height: insets.bottom + theme.spacing.lg }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, alignItems: 'center' },
  viewport: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  circle: { position: 'absolute', borderWidth: 2, opacity: 0.9 },
});
