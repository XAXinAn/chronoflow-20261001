import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { EditorHeader } from '../components/form';
import { Card, PrimaryButton, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { userFacingError } from '../domain/errors';
import { SMS_COOLDOWN_SECONDS, nextCooldown, sendCodeLabel } from '../domain/smsCooldown';
import { maskPhone } from '../domain/profile';

/**
 * 切换（换绑）手机号（spec §6.2）。
 *
 * <p>**两个验证码都要**：旧号一个（证明是本人）+ 新号一个（证明新号码可用）。
 * 只验新号的话，任何拿到 access token 的人都能把手机号换成自己的，等于把账号偷走——
 * 手机号是登录凭证，这一步的安全等级要按「换锁」来设计。
 */
export function PhoneChangeScreen({ onBack }: { onBack: () => void }) {
  const theme = useAppTheme();
  const { api } = useRuntime();
  /** 当前手机号自己拉：这一页是独立路由，上一页不必替它把状态传进来 */
  const [currentPhone, setCurrentPhone] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newCode, setNewCode] = useState('');
  const [oldCode, setOldCode] = useState('');
  /** 两条独立的倒计时：两个号是两次不同的发送，共用一个状态会让按钮互相影响（踩过类似的） */
  const [newCooldown, setNewCooldown] = useState(0);
  const [oldCooldown, setOldCooldown] = useState(0);
  const [sending, setSending] = useState<'new' | 'old' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .meSecurity()
      .then((view) => setCurrentPhone(view.phone))
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

  const newPhoneOk = /^1\d{10}$/.test(newPhone.trim());
  const ready = newPhoneOk && newCode.trim().length === 6 && oldCode.trim().length === 6;

  const send = async (target: 'new' | 'old') => {
    const phone = target === 'new' ? newPhone.trim() : currentPhone;
    if (!/^1\d{10}$/.test(phone)) {
      setError('请先填写正确的新手机号');
      return;
    }
    setSending(target);
    setError(null);
    try {
      await api.sendPhoneCode(phone);
      if (target === 'new') {
        setNewCooldown(SMS_COOLDOWN_SECONDS);
      } else {
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
      await api.changePhone({
        newPhone: newPhone.trim(),
        newCode: newCode.trim(),
        oldCode: oldCode.trim(),
      });
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
            当前手机号：{maskPhone(currentPhone)}。换绑需要**两个**验证码：旧号一个、新号一个。
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
