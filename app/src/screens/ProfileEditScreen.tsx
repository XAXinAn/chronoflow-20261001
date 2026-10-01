import { useState } from 'react';

import { userFacingError } from '../domain/errors';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card, Screen } from '../components/ui';
import { EditorHeader, FormInput } from '../components/form';
import { useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import { MAX_NICKNAME_LENGTH, normalizeNickname, validateNickname } from '../domain/profile';

/**
 * 改名字（昵称，spec §4.1.8 / §6.2 的 `PATCH /me`）。
 *
 * <p>「我的」页原来只把昵称当静态文字显示，用户根本没有地方改它（真机反馈：
 * 「名字无法编辑」）。昵称是**身份级**属性，服务端本来就支持改，缺的只是入口。
 *
 * <p>改完要三处一起更新，少一处就会出现「返回后还是旧名字 / 重启后又变回去」：
 * ① 服务端 `PATCH /me`；② `SessionManager`（内存 + 安全存储）；③ 页面的 React state。
 */
export function ProfileEditScreen({ onBack }: { onBack: () => void }) {
  const theme = useAppTheme();
  const { api, session: sessionManager } = useRuntime();
  const { session, setSession } = useAppSessionState();

  const [nickname, setNickname] = useState(session?.nickname ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (busy) {
      return;
    }
    const problem = validateNickname(nickname);
    if (problem) {
      setError(problem);
      return;
    }
    const next = normalizeNickname(nickname);
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateMe({ nickname: next });
      // 以服务端返回的值为准；它可能是 null（清空），界面会显示「未命名」
      const stored = await sessionManager.updateNickname(updated.nickname ?? null);
      if (stored) {
        setSession(stored);
      }
      onBack();
    } catch (cause) {
      setError(userFacingError(cause, '保存失败，请稍后再试'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <EditorHeader
        title="修改名字"
        onCancel={onBack}
        onSave={() => void save()}
        saving={busy}
      />

      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.md }}
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          <FormInput
            value={nickname}
            placeholder="输入名字"
            accessibilityLabel="名字"
            autoFocus
            fontSize={17}
            onChangeText={(value) => {
              setNickname(value);
              setError(null);
            }}
          />
        </Card>

        <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: theme.spacing.sm }}>
          最多 {MAX_NICKNAME_LENGTH} 个字；名字只用于界面显示，不要求实名。
        </Text>

        {error ? (
          <View
            style={[
              styles.errorBox,
              { borderColor: theme.color.danger, borderRadius: theme.radius.card },
            ]}
          >
            <Text style={{ color: theme.color.danger, fontSize: 13, lineHeight: 19 }}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  errorBox: { borderWidth: 1, padding: 10, marginTop: 12 },
});
