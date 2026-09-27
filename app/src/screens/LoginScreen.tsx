import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { ApiError } from '../api/client';
import type { TokenResponse } from '../api/types';
import { Card, Checkbox, PrimaryButton, Screen } from '../components/ui';
import { useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import { canRequestCode, canSubmitLogin } from '../domain/consent';
import { LEGAL_DOCS, type LegalDoc } from '../domain/legal';
import {
  SMS_COOLDOWN_SECONDS,
  nextCooldown,
  sendCodeLabel,
} from '../domain/smsCooldown';

/**
 * 登录页：**只登录个人账号**（spec §3.2）。
 *
 * 不再有「选身份」这一步——组织账号是在登录后、在组织 tab 的「账户管理」里
 * 用「组织唯一 ID + 成员唯一识别 ID」认领的。
 */
export function LoginScreen({
  onOpenLegal,
}: {
  /** 打开《用户服务协议》/《隐私政策》——登录页必须能点开原文（规范 §四） */
  onOpenLegal: (doc: LegalDoc) => void;
}) {
  const theme = useAppTheme();
  const { api, deviceId } = useRuntime();
  const { applyTokenResponse } = useAppSessionState();

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  /**
   * 是否已主动勾选同意协议与隐私政策。
   *
   * **初值必须是 false**：审核规范明确把「用勾选框形式但默认勾选」与
   * 「注册或登录即默认同意」都列为违规。判定逻辑抽在 domain/consent.ts，由单测盯着。
   */
  const [acceptedPolicy, setAcceptedPolicy] = useState(false);
  const [debugCode, setDebugCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 发码后的倒计时秒数（spec §3.6：同手机号 60 秒 1 条） */
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // 每秒递减；到 0 自动结束（依赖 cooldown 本身，定时器随状态重建）
  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }
    const timer = setTimeout(() => setCooldown((current) => nextCooldown(current)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

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
      setCooldown(SMS_COOLDOWN_SECONDS);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '验证码发送失败');
      // 后端说「发送过于频繁」时也进入倒计时：否则用户会一直点、一直失败
      if (cause instanceof ApiError && cause.code === 20005) {
        setCooldown(SMS_COOLDOWN_SECONDS);
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!canSubmitLogin({ phone, code, acceptedPolicy })) {
      setError('请先阅读并勾选同意《用户服务协议》与《隐私政策》');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.loginBySms(phone.trim(), code.trim(), deviceId);

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
      if (result.session) {
        // 已有个人身份：直接把它的会话写进安全存储，进入 App
        await applyToken(result.session);
        return;
      }
      setError('登录返回异常，请重试');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  const loginReady = canSubmitLogin({ phone, code, acceptedPolicy });

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
              title={sendCodeLabel(cooldown, busy)}
              onPress={() => void sendCode()}
              loading={busy && cooldown === 0}
              // 冷却中也禁用：点不动比点了报错更省事
              disabled={!canRequestCode(phone, cooldown, acceptedPolicy)}
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
          disabled={!loginReady}
        />

        {/*
          合规要点（规范 §四「默认同意」）：
          1. 用**勾选框**、且默认不勾选；
          2. 协议名要能点开原文，而不是只写一行小字；
          3. 未勾选时登录按钮不可点，也不再出现「登录即表示同意」这种替代同意的写法。
        */}
        <View style={{ marginTop: theme.spacing.md }}>
          <Checkbox
            value={acceptedPolicy}
            onToggle={setAcceptedPolicy}
            accessibilityLabel="我已阅读并同意用户服务协议与隐私政策"
          >
            <Text style={{ color: theme.color.textSecondary, fontSize: 13, lineHeight: 20 }}>
              我已阅读并同意
              <Text onPress={() => onOpenLegal('user-agreement')} style={{ color: theme.color.accent }}>
                {LEGAL_DOCS['user-agreement'].label}
              </Text>
              与
              <Text onPress={() => onOpenLegal('privacy-policy')} style={{ color: theme.color.accent }}>
                {LEGAL_DOCS['privacy-policy'].label}
              </Text>
            </Text>
          </Checkbox>
          <Text
            style={{
              color: theme.color.textTertiary,
              fontSize: 12,
              marginTop: 6,
              lineHeight: 18,
            }}
          >
            未满 18 周岁请在监护人陪同下阅读；
            <Text
              onPress={() => onOpenLegal('children-privacy')}
              style={{ color: theme.color.accent }}
            >
              {LEGAL_DOCS['children-privacy'].label}
            </Text>
          </Text>
        </View>
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
