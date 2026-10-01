import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';

import Ionicons from '@expo/vector-icons/Ionicons';

import { ListGroup, ListRow, SectionHeader } from '../components/list';
import { Card, PrimaryButton, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { userFacingError } from '../domain/errors';
import { EmailBindScreen } from './EmailBindScreen';

/** 与「我的」页一致的行图标（同尺寸、同色）。 */
function RowIcon({ name }: { name: keyof typeof Ionicons.glyphMap }) {
  const theme = useAppTheme();
  return <Ionicons name={name} size={20} color={theme.color.textSecondary} />;
}

interface SecurityView {
  email: string | null;
  emailVerified: boolean;
  realNameVerified: boolean;
  realName: string | null;
}

/**
 * 「我的 → 账号与安全」（spec §6.2）：实名认证 + 邮箱绑定，**两个都是可选的**。
 *
 * <p>为什么是可选的：老项目把它们放在注册流程里强制（不实名不让用），新需求是
 * 「登录后可选」——先用起来，需要发日程 / 收通知时再补。所以这里既不做登录拦截，
 * 也不给未认证的用户任何功能折扣。
 *
 * <p>实名走**阿里云 CloudAuth 的 H5 认证页**（WebView）：服务端换 `certifyUrl`，
 * 人脸在阿里云的页面里做完，回到 App 再回查一次结果——**身份证号与姓名只在发起那一次上行**，
 * 服务端加密存储（见 `RealNameService`）。服务未配置时如实说「暂不可用」，不假装在认证。
 */
export function AccountSecurityScreen({ onBack }: { onBack: () => void }) {
  const theme = useAppTheme();
  const { api } = useRuntime();
  const [view, setView] = useState<SecurityView | null>(null);
  const [mode, setMode] = useState<'list' | 'email' | 'realname'>('list');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.meSecurity());
      setError(null);
    } catch (cause) {
      setError(userFacingError(cause, '读不到账号安全信息'));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (mode === 'email') {
    return (
      <EmailBindScreen
        currentEmail={view?.email ?? null}
        onDone={() => {
          setMode('list');
          void load();
        }}
      />
    );
  }

  if (mode === 'realname') {
    return (
      <RealNameFlow
        onCancel={() => setMode('list')}
        onVerified={() => {
          setMode('list');
          void load();
        }}
      />
    );
  }

  return (
    <Screen style={styles.container}>
      <View style={styles.header}>
        <PrimaryButton title="返回" onPress={onBack} />
      </View>
      <SectionHeader title="账号与安全" />
      <ListGroup>
        <ListRow
          leading={<RowIcon name="shield-checkmark-outline" />}
          title="实名认证"
          subtitle={
            view?.realNameVerified
              ? `已实名${view.realName ? ` · ${maskName(view.realName)}` : ''}`
              : '未认证（可选，认证后可用于找回账号）'
          }
          onPress={() => setMode('realname')}
        />
        <ListRow
          leading={<RowIcon name="mail-outline" />}
          title="邮箱"
          subtitle={view?.email ? view.email : '未绑定（用于接收通知）'}
          onPress={() => setMode('email')}
        />
      </ListGroup>
      {error ? <Text style={{ color: theme.color.danger, marginTop: theme.spacing.md }}>{error}</Text> : null}
    </Screen>
  );
}

/** 实名只露首字，别把姓名整条摆出来（截图 / 旁人一眼就看到了）。 */
function maskName(name: string): string {
  return name.length <= 1 ? name : `${name.charAt(0)}${'*'.repeat(name.length - 1)}`;
}

/** 填姓名 + 身份证 → 打开 CloudAuth 的认证页 → 回查结果。 */
function RealNameFlow({ onCancel, onVerified }: { onCancel: () => void; onVerified: () => void }) {
  const theme = useAppTheme();
  const { api } = useRuntime();
  const [realName, setRealName] = useState('');
  const [idCardNumber, setIdCard] = useState('');
  const [certify, setCertify] = useState<{ certifyId: string; certifyUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idOk = /^\d{17}[\dXx]$/.test(idCardNumber.trim());
  const ready = realName.trim().length >= 2 && idOk;

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
        <WebView source={{ uri: certify.certifyUrl }} onError={() => setError('认证页打不开，请重试')} />
        <View style={{ padding: 16 }}>
          {error ? <Text style={{ color: theme.color.danger, marginBottom: 8 }}>{error}</Text> : null}
          <PrimaryButton title={busy ? '正在确认…' : '我已完成人脸认证'} onPress={() => void check()} loading={busy} />
        </View>
      </View>
    );
  }

  return (
    <Screen style={styles.container}>
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
        {error ? <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.sm }}>{error}</Text> : null}
        <View style={{ height: theme.spacing.lg }} />
        <PrimaryButton title="开始认证" onPress={() => void start()} loading={busy} disabled={!ready} />
        <View style={{ height: theme.spacing.sm }} />
        <PrimaryButton title="返回" onPress={onCancel} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 20, paddingTop: 12 },
  header: { marginBottom: 12 },
  label: { fontSize: 13, marginBottom: 6 },
  input: { height: 48, borderWidth: 1, paddingHorizontal: 12, fontSize: 16, borderRadius: 10 },
});
