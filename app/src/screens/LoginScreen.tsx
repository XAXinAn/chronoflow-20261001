import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { ApiError } from '../api/client';
import type { IdentityView, TokenResponse } from '../api/types';
import { Card, PrimaryButton, Screen } from '../components/ui';
import { useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';

interface LoginScreenProps {
  onNeedSelectIdentity: (payload: { selectToken: string; identities: IdentityView[] }) => void;
}

export function LoginScreen({ onNeedSelectIdentity }: LoginScreenProps) {
  const theme = useAppTheme();
  const { api, deviceId } = useRuntime();
  const { applyTokenResponse } = useAppSessionState();

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [debugCode, setDebugCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyToken = async (token: TokenResponse) => {
    await applyTokenResponse(token);
  };

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.sendSmsCode(phone.trim());
      // 开发环境后端会回显验证码；生产环境该字段不存在
      setDebugCode(result.debugCode ?? null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '验证码发送失败');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.loginBySms(phone.trim(), code.trim());

      if (result.needRegister && result.registerToken) {
        // 首次登录：账号已建，直接创建个人身份进入；昵称可在设置里改
        const token = await api.createPersonalIdentity(
          result.registerToken,
          `用户${phone.trim().slice(-4)}`,
          deviceId,
        );
        await applyToken(token);
        return;
      }
      if (result.selectToken) {
        onNeedSelectIdentity({ selectToken: result.selectToken, identities: result.identities });
        return;
      }
      setError('登录返回异常，请重试');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  const phoneReady = phone.trim().length === 11;
  const codeReady = code.trim().length === 6;

  return (
    <Screen style={styles.container}>
      <View style={{ marginBottom: theme.spacing.lg }}>
        <Text style={[styles.title, { color: theme.color.textPrimary }]}>XaTodo</Text>
        <Text style={{ color: theme.color.textSecondary }}>心安待办</Text>
      </View>

      <Card>
        <Text style={[styles.label, { color: theme.color.textSecondary }]}>手机号</Text>
        <TextInput
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          placeholder="11 位手机号"
          accessibilityLabel="手机号"
          placeholderTextColor={theme.color.textTertiary}
          style={[
            styles.input,
            { color: theme.color.textPrimary, borderColor: theme.color.border, borderRadius: theme.radius.input },
          ]}
        />

        <View style={{ height: theme.spacing.md }} />

        <Text style={[styles.label, { color: theme.color.textSecondary }]}>验证码</Text>
        <View style={styles.codeRow}>
          <TextInput
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={6}
            placeholder="6 位数字"
            accessibilityLabel="验证码"
            placeholderTextColor={theme.color.textTertiary}
            style={[
              styles.input,
              styles.codeInput,
              { color: theme.color.textPrimary, borderColor: theme.color.border, borderRadius: theme.radius.input },
            ]}
          />
          <View style={styles.codeButton}>
            <PrimaryButton
              title="获取验证码"
              onPress={() => void sendCode()}
              loading={busy}
              disabled={!phoneReady}
            />
          </View>
        </View>

        {debugCode ? (
          <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: theme.spacing.xs }}>
            开发环境验证码：{debugCode}
          </Text>
        ) : null}

        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.sm }}>{error}</Text>
        ) : null}

        <View style={{ height: theme.spacing.lg }} />
        <PrimaryButton
          title="登录 / 注册"
          onPress={() => void submit()}
          loading={busy}
          disabled={!phoneReady || !codeReady}
        />

        <Text
          style={{
            color: theme.color.textTertiary,
            fontSize: 12,
            marginTop: theme.spacing.md,
            textAlign: 'center',
          }}
        >
          登录即表示同意用户协议与隐私政策
        </Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { justifyContent: 'center', paddingHorizontal: 24 },
  title: { fontSize: 34, fontWeight: '600', letterSpacing: -0.5 },
  label: { fontSize: 13, marginBottom: 6 },
  input: { height: 48, borderWidth: 1, paddingHorizontal: 12, fontSize: 16 },
  codeRow: { flexDirection: 'row', alignItems: 'center' },
  codeInput: { flex: 1 },
  codeButton: { width: 132, marginLeft: 12 },
});
