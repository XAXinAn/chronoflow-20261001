import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { EditorHeader } from '../components/form';
import { Card, PrimaryButton, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { userFacingError } from '../domain/errors';

/**
 * 实名认证**独立页**（spec §6.2）：姓名 + 身份证 → 阿里云 CloudAuth 的 H5 认证页 → 回查结果。
 *
 * <p>为什么是独立路由而不是塞在「账号与安全」里：它自己就是一个两步流程（填表 → 跳出去做人脸），
 * 有自己的返回需求；套在别的页面里，返回键的语义会变得含糊。
 *
 * <p>身份证号只在发起那一次上行，服务端加密保存（见 `RealNameService`）；人脸在阿里云页面完成，
 * 我们不接触人脸数据。
 */
export function RealNameScreen({ onBack, onVerified }: { onBack: () => void; onVerified: () => void }) {
  const theme = useAppTheme();
  const { api } = useRuntime();
  const [realName, setRealName] = useState('');
  const [idCardNumber, setIdCard] = useState('');
  const [certify, setCertify] = useState<{ certifyId: string; certifyUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = realName.trim().length >= 2 && /^\d{17}[\dXx]$/.test(idCardNumber.trim());

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setCertify(await api.initRealName({ realName: realName.trim(), idCardNumber: idCardNumber.trim() }));
    } catch (cause) {
      setError(userFacingError(cause, '实名认证服务暂时不可用'));
    } finally {
      setBusy(false);
    }
  };

  /** 人脸的判定在阿里云那边，可能晚一两秒才落定，所以回查几次而不是查一次就报失败。 */
  const check = async () => {
    if (!certify) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await api.realNameResult(certify.certifyId);
        if (result.verified) {
          onVerified();
          return;
        }
        if (result.message && !/未完成|处理中/.test(result.message)) {
          setError(result.message);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      setError('还没有拿到认证结果，请稍后再试一次');
    } catch (cause) {
      setError(userFacingError(cause, '查询认证结果失败'));
    } finally {
      setBusy(false);
    }
  };

  if (certify) {
    return (
      <View style={{ flex: 1 }}>
        {/* 人脸在阿里云的页面里做：这里给一个明确的出口，用户随时能退出 */}
        <View>
          <EditorHeader title="人脸认证" cancelLabel="返回" onCancel={() => setCertify(null)} />
        </View>
        <WebView source={{ uri: certify.certifyUrl }} onError={() => setError('认证页打不开，请重试')} />
        <View style={{ padding: 16 }}>
          {error ? <Text style={{ color: theme.color.danger, marginBottom: 8 }}>{error}</Text> : null}
          <PrimaryButton
            title={busy ? '正在确认…' : '我已完成人脸认证'}
            onPress={() => void check()}
            loading={busy}
          />
        </View>
      </View>
    );
  }

  return (
    <Screen style={styles.container}>
      <EditorHeader title="实名认证" cancelLabel="返回" onCancel={onBack} />
      <Card>
        <Text style={{ color: theme.color.textSecondary, fontSize: 13, lineHeight: 20 }}>
          实名认证由阿里云实人认证完成：填写姓名与身份证号后，会打开一个人脸活体检测页面。
          身份证号由服务端加密保存，不用于其它用途。
        </Text>
        <View style={{ height: theme.spacing.md }} />
        <Text style={[styles.label, { color: theme.color.textSecondary }]}>真实姓名</Text>
        <TextInput
          value={realName}
          onChangeText={setRealName}
          accessibilityLabel="真实姓名"
          placeholder="与身份证一致"
          placeholderTextColor={theme.color.textTertiary}
          style={[styles.input, { color: theme.color.textPrimary, borderColor: theme.color.border }]}
        />
        <View style={{ height: theme.spacing.md }} />
        <Text style={[styles.label, { color: theme.color.textSecondary }]}>身份证号</Text>
        <TextInput
          value={idCardNumber}
          onChangeText={setIdCard}
          autoCapitalize="characters"
          maxLength={18}
          accessibilityLabel="身份证号"
          placeholder="18 位"
          placeholderTextColor={theme.color.textTertiary}
          style={[styles.input, { color: theme.color.textPrimary, borderColor: theme.color.border }]}
        />
        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.sm }}>{error}</Text>
        ) : null}
        <View style={{ height: theme.spacing.lg }} />
        <PrimaryButton title="开始认证" onPress={() => void start()} loading={busy} disabled={!ready} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 20 },
  label: { fontSize: 13, marginBottom: 6 },
  input: { height: 48, borderWidth: 1, paddingHorizontal: 12, fontSize: 16, borderRadius: 10 },
});
