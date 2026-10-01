import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { PrimaryButton, Card, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { userFacingError } from '../domain/errors';
import { SMS_COOLDOWN_SECONDS, nextCooldown, sendCodeLabel } from '../domain/smsCooldown';
import { loginButtons } from '../domain/loginForm';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 绑定 / 改绑邮箱（spec §6.2「账号与安全」）。
 *
 * <p>邮箱走**阿里云 DirectMail**：先给新邮箱发验证码，验过才写进账号（邮箱在库里唯一，
 * 已被别的账号占用会被拒）。**邮箱属于账号级信息**，切到组织身份也是同一个邮箱。
 *
 * <p>两个按钮的转圈状态复用登录页那套纯逻辑（`domain/loginForm.ts`）——同一个坑不要踩两次：
 * 发码只让发码按钮转，提交只让提交按钮转。
 */
export function EmailBindScreen({ currentEmail, onDone }: {
  /** 当前已绑定的邮箱（没绑就是 null），只做展示 */
  currentEmail: string | null;
  onDone: (email: string) => void;
}) {
  const theme = useAppTheme();
  const { api } = useRuntime();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }
    const timer = setTimeout(() => setCooldown((current) => nextCooldown(current)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const emailReady = EMAIL_PATTERN.test(email.trim());
  const buttons = loginButtons({
    sendingCode: sending,
    submitting,
    canRequestCode: emailReady && cooldown === 0,
    canSubmitLogin: emailReady && code.trim().length === 6,
  });

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const result = await api.sendEmailCode(email.trim());
      // 开发环境（没接真邮件通道）会回显验证码，直接填上，界面上不写「开发环境」这种字样
      if (result.debugCode) {
        setCode(result.debugCode);
      }
      setCooldown(SMS_COOLDOWN_SECONDS);
    } catch (cause) {
      setError(userFacingError(cause, '验证码发送失败'));
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const view = await api.bindEmail({ email: email.trim(), code: code.trim() });
      onDone(view.email ?? email.trim());
    } catch (cause) {
      setError(userFacingError(cause, '绑定失败，请重试'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen style={styles.container}>
      <Card>
        <Text style={{ color: theme.color.textSecondary, fontSize: 13 }}>
          {currentEmail ? `当前邮箱：${currentEmail}` : '还没有绑定邮箱'}
        </Text>
        <View style={{ height: theme.spacing.md }} />

        <Text style={[styles.label, { color: theme.color.textSecondary }]}>邮箱</Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          placeholder="用于接收通知"
          accessibilityLabel="邮箱"
          placeholderTextColor={theme.color.textTertiary}
          style={[styles.input, { color: theme.color.textPrimary, borderColor: theme.color.border, borderRadius: theme.radius.input }]}
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
            accessibilityLabel="邮箱验证码"
            placeholderTextColor={theme.color.textTertiary}
            style={[styles.input, styles.codeInput, { color: theme.color.textPrimary, borderColor: theme.color.border, borderRadius: theme.radius.input }]}
          />
          <View style={styles.codeButton}>
            <PrimaryButton
              title={sendCodeLabel(cooldown, buttons.sendCode.loading)}
              onPress={() => void send()}
              loading={buttons.sendCode.loading}
              disabled={buttons.sendCode.disabled}
            />
          </View>
        </View>

        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.sm }}>{error}</Text>
        ) : null}

        <View style={{ height: theme.spacing.lg }} />
        <PrimaryButton
          title={currentEmail ? '更换邮箱' : '绑定邮箱'}
          onPress={() => void submit()}
          loading={buttons.submit.loading}
          disabled={buttons.submit.disabled}
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { justifyContent: 'center', paddingHorizontal: 24 },
  label: { fontSize: 13, marginBottom: 6 },
  input: { height: 48, borderWidth: 1, paddingHorizontal: 12, fontSize: 16 },
  codeRow: { flexDirection: 'row', alignItems: 'center' },
  codeInput: { flex: 1 },
  codeButton: { width: 132, marginLeft: 12 },
});
