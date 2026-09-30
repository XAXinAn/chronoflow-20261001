import { useEffect, useState, type ComponentType } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet } from 'react-native';

import { useAppTheme } from '../context/AppContext';

/**
 * 语音输入按钮（spec §11 阶段三）。
 *
 * <p>这一层只做一件事：**延迟加载真正的录音实现**。
 * 录音要用 `expo-audio`，而缺这个原生模块的构建（Web 预览、裁剪过的包）在
 * `import` 那一刻就会抛错——顶层静态 import 会让整个 App 起不来。
 * 「语音输入」只是小安的一个输入方式，不该有这种代价。
 */

export interface MicRecordingHint {
  seconds: number;
  /** 0..1，音量条用 */
  level: number;
  slidingCancel: boolean;
}

export interface MicProps {
  disabled: boolean;
  /** 录音中每 100ms 回调一次；不录音时回调 null */
  onHint: (hint: MicRecordingHint | null) => void;
  onRecorded: (uri: string) => void;
  onError: (message: string) => void;
}

export function MicRecorder(props: MicProps) {
  const [impl, setImpl] = useState<ComponentType<MicProps> | null>(null);

  useEffect(() => {
    let active = true;
    void import('./agentMicImpl')
      .then((module) => {
        if (active) {
          setImpl(() => module.MicRecorderImpl);
        }
      })
      .catch(() => {
        // 原生模块缺失：保持下面的兜底按钮，点一下会明确说明不可用
      });
    return () => {
      active = false;
    };
  }, []);

  if (impl) {
    const Impl = impl;
    return <Impl {...props} />;
  }
  return <UnavailableMic disabled={props.disabled} onError={props.onError} />;
}

function UnavailableMic({ disabled, onError }: { disabled: boolean; onError: (m: string) => void }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="语音输入（当前不可用）"
      disabled={disabled}
      onPress={() => onError('这个版本不支持语音输入，直接打字也一样')}
      style={[styles.button, { borderColor: theme.color.border, opacity: disabled ? 0.4 : 1 }]}
    >
      <Ionicons name="mic-outline" size={20} color={theme.color.textTertiary} />
    </Pressable>
  );
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
