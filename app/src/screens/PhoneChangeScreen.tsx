import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { EditorHeader, SegmentedControl } from '../components/form';
import { Card, PrimaryButton, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { userFacingError } from '../domain/errors';
import { SMS_COOLDOWN_SECONDS, nextCooldown, sendCodeLabel } from '../domain/smsCooldown';
import { maskPhone } from '../domain/profile';

/**
 * 切换（换绑）手机号（spec §6.2）。
 *
 * <p>新号一个验证码（证明新号码可用）+ 一个「本人验证」，二选一：
 * <ul>
 *   <li>**旧号验证码**（默认）：旧号还在用时的常规路径；</li>
 *   <li>**已绑定邮箱的验证码**：旧号丢了 / 停用时的替代路径。
 *       要求账号先绑定邮箱，且邮箱地址由服务端取，客户端传不了。</li>
 * </ul>
 * 只验新号的话，任何拿到 access token 的人都能把手机号换成自己的，等于把账号偷走——
 * 手机号是登录凭证，这一步的安全等级要按「换锁」来设计。
 */
export function PhoneChangeScreen({ onBack }: { onBack: () => void }) {
  const theme = useAppTheme();
  const { api } = useRuntime();
  /** 当前手机号自己拉：这一页是独立路由，上一页不必替它把状态传进来 */
  const [currentPhone, setCurrentPhone] = useState('');
  /** 账号有没有绑定邮箱：决定「旧号不能用了」这条路走不走得通 */
  const [email, setEmail] = useState<string | null>(null);
  /** 本人验证方式：旧号验证码（默认）或邮箱验证码 */
  const [verifyBy, setVerifyBy] = useState<'old' | 'email'>('old');
  const [newPhone, setNewPhone] = useState('');
  const [newCode, setNewCode] = useState('');
  const [oldCode, setOldCode] = useState('');
  const [emailCode, setEmailCode] = useState('');
  /** 两条独立的倒计时：两个号是两次不同的发送，共用一个状态会让按钮互相影响（踩过类似的） */
  const [newCooldown, setNewCooldown] = useState(0);
  const [oldCooldown, setOldCooldown] = useState(0);
  const [emailCooldown, setEmailCooldown] = useState(0);
  const [sending, setSending] = useState<'new' | 'old' | 'email' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .meSecurity()
      .then((view) => {
        setCurrentPhone(view.phone);
        setEmail(view.emailVerified && view.email ? view.email : null);
      })
      .catch(() => {
        // 读不到就当空：换绑提交时服务端会再校验一次旧号验证码
      });
  }, [api]);

  useEffect(() => {
    if (newCooldown <= 0) {
      return;
    }
    const timer = setTimeout(() => setNewCooldown((current) => nextCooldown(current)), 1000);
    return () => clearTimeout(timer);
  }, [newCooldown]);

  useEffect(() => {
    if (oldCooldown <= 0) {
      return;
    }
    const timer = setTimeout(() => setOldCooldown((current) => nextCooldown(current)), 1000);
    return () => clearTimeout(timer);
  }, [oldCooldown]);

  useEffect(() => {
    if (emailCooldown <= 0) {
      return;
    }
    const timer = setTimeout(() => setEmailCooldown((current) => nextCooldown(current)), 1000);
    return () => clearTimeout(timer);
  }, [emailCooldown]);

  const newPhoneOk = /^1\d{10}$/.test(newPhone.trim());
  const proofOk =
    verifyBy === 'old' ? oldCode.trim().length === 6 : emailCode.trim().length === 6;
  const ready = newPhoneOk && newCode.trim().length === 6 && proofOk;

  const send = async (target: 'new' | 'old' | 'email') => {
    const phone = target === 'new' ? newPhone.trim() : currentPhone;
    if (target !== 'email' && !/^1\d{10}$/.test(phone)) {
      setError('请先填写正确的新手机号');
      return;
    }
    setSending(target);
    setError(null);
    try {
      if (target === 'email') {
        await api.sendPhoneChangeEmailCode();
        setEmailCooldown(SMS_COOLDOWN_SECONDS);
      } else {
        await api.sendPhoneCode(phone);
      }
      if (target === 'new') {
        setNewCooldown(SMS_COOLDOWN_SECONDS);
      } else if (target === 'old') {
        setOldCooldown(SMS_COOLDOWN_SECONDS);
      }
    } catch (cause) {
      setError(userFacingError(cause, '验证码发送失败'));
    } finally {
      setSending(null);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.changePhone(
        verifyBy === 'old'
          ? { newPhone: newPhone.trim(), newCode: newCode.trim(), oldCode: oldCode.trim() }
          : { newPhone: newPhone.trim(), newCode: newCode.trim(), emailCode: emailCode.trim() },
      );
      onBack();
    } catch (cause) {
      setError(userFacingError(cause, '换绑失败，请重试'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <EditorHeader title="切换手机号" cancelLabel="返回" onCancel={onBack} />
      <View style={styles.body}>
        <Card>
          <Text style={{ color: theme.color.textSecondary, fontSize: 13, lineHeight: 20 }}>
            当前手机号：{maskPhone(currentPhone)}。换绑需要两个验证码：新号一个，外加一次「本人验证」。
          </Text>

          <View style={{ height: theme.spacing.md }} />
          <Text style={[styles.label, { color: theme.color.textSecondary }]}>新手机号</Text>
          <View style={styles.row}>
            <TextInput
              value={newPhone}
              onChangeText={setNewPhone}
              keyboardType="phone-pad"
              maxLength={11}
              accessibilityLabel="新手机号"
              placeholder="11 位手机号"
              placeholderTextColor={theme.color.textTertiary}
              style={[styles.input, styles.flex, { color: theme.color.textPrimary, borderColor: theme.color.border }]}
            />
            <View style={styles.codeButton}>
              <PrimaryButton
                title={sendCodeLabel(newCooldown, sending === 'new')}
                onPress={() => void send('new')}
                loading={sending === 'new'}
                disabled={sending !== null || newCooldown > 0 || !newPhoneOk}
              />
            </View>
          </View>

          <View style={{ height: theme.spacing.md }} />
          <Text style={[styles.label, { color: theme.color.textSecondary }]}>新号验证码</Text>
          <TextInput
            value={newCode}
            onChangeText={setNewCode}
            keyboardType="number-pad"
            maxLength={6}
            accessibilityLabel="新号验证码"
            placeholder="6 位数字"
            placeholderTextColor={theme.color.textTertiary}
            style={[styles.input, { color: theme.color.textPrimary, borderColor: theme.color.border }]}
          />

          <View style={{ height: theme.spacing.md }} />
          {/*
            本人验证方式。默认旧号验证码；旧号已经停用 / 丢卡的人切到邮箱，
            前提是账号绑过邮箱——没绑定就在下面如实说明并引导去绑定，而不是给一个点不动的按钮。
          */}
          <Text style={[styles.label, { color: theme.color.textSecondary }]}>本人验证</Text>
          <SegmentedControl<'old' | 'email'>
            label="本人验证方式"
            options={[
              { value: 'old', label: `旧号 ${maskPhone(currentPhone)}` },
              { value: 'email', label: '邮箱' },
            ]}
            value={verifyBy}
            onChange={setVerifyBy}
          />

          {verifyBy === 'old' ? (
            <>
              <View style={{ height: theme.spacing.md }} />
              <Text style={[styles.label, { color: theme.color.textSecondary }]}>
                旧号验证码（发给 {maskPhone(currentPhone)}）
              </Text>
              <View style={styles.row}>
                <TextInput
                  value={oldCode}
                  onChangeText={setOldCode}
                  keyboardType="number-pad"
                  maxLength={6}
                  accessibilityLabel="旧号验证码"
                  placeholder="6 位数字"
                  placeholderTextColor={theme.color.textTertiary}
                  style={[styles.input, styles.flex, { color: theme.color.textPrimary, borderColor: theme.color.border }]}
                />
                <View style={styles.codeButton}>
                  <PrimaryButton
                    title={sendCodeLabel(oldCooldown, sending === 'old')}
                    onPress={() => void send('old')}
                    loading={sending === 'old'}
                    disabled={sending !== null || oldCooldown > 0}
                  />
                </View>
              </View>
            </>
          ) : (
            <>
              <View style={{ height: theme.spacing.md }} />
              {email ? (
                <>
                  <Text style={[styles.label, { color: theme.color.textSecondary }]}>
                    邮箱验证码（发给 {email}）
                  </Text>
                  <View style={styles.row}>
                    <TextInput
                      value={emailCode}
                      onChangeText={setEmailCode}
                      keyboardType="number-pad"
                      maxLength={6}
                      accessibilityLabel="邮箱验证码"
                      placeholder="6 位数字"
                      placeholderTextColor={theme.color.textTertiary}
                      style={[styles.input, styles.flex, { color: theme.color.textPrimary, borderColor: theme.color.border }]}
                    />
                    <View style={styles.codeButton}>
                      <PrimaryButton
                        title={sendCodeLabel(emailCooldown, sending === 'email')}
                        onPress={() => void send('email')}
                        loading={sending === 'email'}
                        disabled={sending !== null || emailCooldown > 0}
                      />
                    </View>
                  </View>
                </>
              ) : (
                <Text style={{ color: theme.color.textSecondary, fontSize: 13, lineHeight: 20 }}>
                  旧手机号不能用了？账号还没有绑定邮箱，无法用邮箱验证。请先在「我的 → 账号与安全 →
                  邮箱」绑定并验证一个邮箱，再回来换号。
                </Text>
              )}
            </>
          )}

          {error ? (
            <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.sm }}>{error}</Text>
          ) : null}

          <View style={{ height: theme.spacing.lg }} />
          <PrimaryButton title="确认换绑" onPress={() => void submit()} loading={busy} disabled={!ready} />
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: 20, paddingTop: 16 },
  label: { fontSize: 13, marginBottom: 6 },
  input: { height: 48, borderWidth: 1, paddingHorizontal: 12, fontSize: 16, borderRadius: 10 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  codeButton: { width: 132, marginLeft: 12 },
});
