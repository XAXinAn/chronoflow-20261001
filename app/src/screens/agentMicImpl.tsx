import { useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { PanResponder, StyleSheet, View } from 'react-native';
import {
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';

import { askPermission } from '../components/permission';
import { useAppTheme } from '../context/AppContext';
import type { MicProps } from './agentMic';

/** 按住多久才算「说话」——太短会被当成误触，太短的长按又让人以为按钮坏了。 */
const HOLD_THRESHOLD_MS = 200;
/** 上滑多少像素算取消（Dy 为负表示向上）。 */
const SLIDE_CANCEL_PX = -60;
/** 录音上限：与 spec 的 60 秒一致。 */
const MAX_RECORD_MS = 60_000;

/**
 * 真正的录音实现（spec §11 阶段三）。
 *
 * <p>交互照「长按说话」那套：按住 → 浮层显示计时与音量 → 松手结束并转写 →
 * 转出来的文字填进输入框（**不自动发送**）；上滑到阈值外松手 = 取消。
 *
 * <p>用 PanResponder 而不是 Pressable：只有它能在按住期间拿到手指移动，
 * 「上滑取消」必须靠这个。
 */
export function MicRecorderImpl({ disabled, onHint, onRecorded, onError }: MicProps) {
  const theme = useAppTheme();
  const recorder = useAudioRecorder({ ...RecordingPresets.LOW_QUALITY, isMeteringEnabled: true });
  const recorderState = useAudioRecorderState(recorder, 100);

  const [recording, setRecording] = useState(false);
  const [slidingCancel, setSlidingCancel] = useState(false);
  const recordingRef = useRef(false);
  const slidingRef = useRef(false);
  /** 手指是否还按在按钮上（松手 / 被系统打断都要置 false） */
  const touchActiveRef = useRef(false);
  const disabledRef = useRef(disabled);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef(0);

  disabledRef.current = disabled;

  const begin = async () => {
    if (recordingRef.current || disabledRef.current) {
      return;
    }
    const granted = await askPermission('microphone');
    if (!granted) {
      return;
    }
    /**
     * 首次长按必然要弹「先说明用途」+ 系统权限窗，而那时用户的手指早就松了。
     * 不挡这一道的话，授权通过后会**在没有按键的情况下开始录音**，
     * 一直录到 60 秒上限才自己停——用户看到的是「麦克风自己录了一分钟」。
     */
    if (!touchActiveRef.current) {
      return;
    }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (!touchActiveRef.current) {
        void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        return;
      }
      recorder.record();
      startedAtRef.current = Date.now();
      slidingRef.current = false;
      setSlidingCancel(false);
      recordingRef.current = true;
      setRecording(true);
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : '录音启动失败');
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    }
  };

  const finish = async (cancelled: boolean) => {
    if (!recordingRef.current) {
      return;
    }
    recordingRef.current = false;
    touchActiveRef.current = false;
    setRecording(false);
    const cancel = cancelled || slidingRef.current;
    slidingRef.current = false;
    setSlidingCancel(false);
    let uri: string | null = null;
    try {
      await recorder.stop();
      uri = recorder.uri ?? recorderState.url ?? null;
    } catch {
      uri = null;
    } finally {
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    }
    if (cancel || !uri) {
      return;
    }
    onRecorded(uri);
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabledRef.current,
      onMoveShouldSetPanResponder: () => !disabledRef.current,
      onPanResponderGrant: () => {
        touchActiveRef.current = true;
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null;
          void begin();
        }, HOLD_THRESHOLD_MS);
      },
      onPanResponderMove: (_event, gesture) => {
        const next = gesture.dy < SLIDE_CANCEL_PX;
        if (next !== slidingRef.current) {
          slidingRef.current = next;
          setSlidingCancel(next);
        }
      },
      onPanResponderRelease: () => {
        touchActiveRef.current = false;
        if (holdTimerRef.current) {
          // 还没到长按阈值就松手了：不录音，但**要说一句**。
          // 原来这里什么都不做，用户点一下得不到任何反馈，看起来就是「按钮坏了」。
          clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
          onError('按住麦克风说话，松开后转成文字，上滑取消');
          return;
        }
        void finish(false);
      },
      onPanResponderTerminate: () => {
        touchActiveRef.current = false;
        if (holdTimerRef.current) {
          clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
          return;
        }
        void finish(true);
      },
    }),
  ).current;

  /** 录音状态 → 浮层提示（父组件据此渲染计时与音量条）。 */
  useEffect(() => {
    if (!recording) {
      onHint(null);
      return;
    }
    const elapsed =
      recorderState.durationMillis > 0
        ? recorderState.durationMillis
        : Date.now() - startedAtRef.current;
    onHint({
      seconds: elapsed / 1000,
      level: meteringToLevel(recorderState.metering),
      slidingCancel,
    });
  }, [onHint, recorderState.durationMillis, recorderState.metering, recording, slidingCancel]);

  /** 到 60 秒自动收尾：再长也不是一句话了，而转写是按秒计的。 */
  useEffect(() => {
    if (recording && recorderState.durationMillis >= MAX_RECORD_MS) {
      void finish(false);
    }
  });

  return (
    /**
     * 用 `View` 而不是 `Pressable` 承载 PanResponder。
     *
     * <p>`Pressable` 内部是 `<View {...restProps} {...pressabilityEventHandlers} />` ——
     * Pressability 的 `onStartShouldSetResponder` / `onResponderGrant` 展开在后面，
     * **会整块盖掉**传进去的 `panHandlers`，于是长按永远不触发、语音按钮点不动。
     * 这个按钮要的是「按住 + 上滑」的手势，不是点按，所以直接用 View 接手势。
     */
    <View
      {...responder.panHandlers}
      accessibilityRole="button"
      accessibilityLabel="按住说话"
      accessibilityHint="按住开始录音，上滑取消，松开后转成文字"
      accessibilityState={{ disabled }}
      accessible
      style={[
        styles.button,
        {
          borderColor: recording ? theme.color.accent : theme.color.border,
          backgroundColor: recording ? theme.color.accent : 'transparent',
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Ionicons
        name={recording ? 'mic' : 'mic-outline'}
        size={20}
        color={recording ? theme.color.accentContrast : theme.color.textSecondary}
      />
    </View>
  );
}

/**
 * 分贝 → 0..1 的音量条。
 *
 * <p>metering 是 dB（安静时约 -60 甚至更低），直接用它画条会一直贴底，
 * 所以按 -60..0 归一化再夹到 0..1。
 */
function meteringToLevel(metering: number | undefined): number {
  if (metering === undefined || Number.isNaN(metering)) {
    return 0;
  }
  return Math.max(0, Math.min(1, (metering + 60) / 60));
}

const styles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
