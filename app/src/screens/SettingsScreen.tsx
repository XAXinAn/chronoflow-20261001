import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';

import { ApiError } from '../api/client';
import type { IdentityView } from '../api/types';
import { ListGroup, ListRow, ListSeparator, SectionHeader } from '../components/list';
import { useAppScheme, useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import { absoluteMediaUrl } from '../domain/media';

/**
 * 「我的」页。
 *
 * 结构对齐商用 App 的通行做法：**顶部个人信息区 + 若干带图标的分组列表**。
 * 之前那版是一行行纯文字，读起来像配置文件——分组、图标、层级都是靠视觉建立的，
 * 不该让用户去逐行读文字。
 */
export function SettingsScreen({
  onOpenIdentitySwitch,
  onOpenFeedback,
}: {
  onOpenIdentitySwitch: () => void;
  onOpenFeedback: () => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const scheme = useAppScheme();
  const { api, baseUrl } = useRuntime();
  const { session, toggleScheme, signOut } = useAppSessionState();

  const [identities, setIdentities] = useState<IdentityView[]>([]);
  /**
   * 当前身份信息从服务端读，而不是只在本地会话里取：
   * 头像是身份级属性（spec §4.1.8），本地会话缓存里没有它，重启后也必须还在。
   */
  const [profile, setProfile] = useState<IdentityView | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const loadIdentities = useCallback(async () => {
    try {
      setIdentities(await api.identities());
    } catch {
      // 身份列表拿不到不影响本页其他内容
    }
  }, [api]);

  const loadProfile = useCallback(async () => {
    try {
      setProfile(await api.me());
    } catch {
      // 资料拿不到不影响本页其他内容（会话里还有昵称）
    }
  }, [api]);

  useEffect(() => {
    void loadIdentities();
    void loadProfile();
  }, [loadIdentities, loadProfile]);

  /**
   * 换头像：选图 → 上传拿到相对 URL → PATCH /me 回填（spec §4.1.8）。
   *
   * 顺序不能反：先上传再写资料，中途失败最多留一张没人引用的图片（无害），
   * 反过来会写出一个指向不存在文件的 avatarUrl，界面上就是一个永远加载不出来的头像。
   */
  const pickAvatar = async () => {
    setAvatarError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setAvatarError('需要相册权限才能更换头像');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      // 刻意不开 allowsEditing：它会拉起系统裁剪页，而 AOSP 那个页面的确认按钮
      // 在部分机型/模拟器上根本渲染不出来（实测只有翻转菜单），用户会卡在里面出不来。
      // 头像是圆形裁切显示（overflow: hidden），本来也不需要系统裁剪。
      quality: 0.8,
    });
    if (picked.canceled || picked.assets.length === 0) {
      return;
    }
    const asset = picked.assets[0];
    setAvatarBusy(true);
    try {
      const uploaded = await api.uploadImage(asset.uri);
      setProfile(await api.updateMe({ avatarUrl: uploaded.url }));
    } catch (cause) {
      // 非 ApiError 说明请求根本没到服务端（典型是 RN 的 fetch 在 multipart 上出错），
      // 这时把原始信息留下来，否则排查只能靠猜
      console.warn('[avatar] 上传/更新失败', cause);
      setAvatarError(cause instanceof ApiError ? cause.message : '头像更新失败，请稍后再试');
    } finally {
      setAvatarBusy(false);
    }
  };

  const logout = async () => {
    if (session) {
      try {
        await api.logout(session.refreshToken);
      } catch {
        // 服务端吊销失败也要清掉本地会话
      }
    }
    await signOut();
  };

  const isOrg = session?.identityType === 'ORG_MEMBER';
  const nickname = session?.nickname ?? '未命名';
  const otherIdentityCount = identities.filter((item) => item.identityId !== session?.identityId).length;

  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: theme.spacing.md,
        paddingTop: insets.top + theme.spacing.sm,
        paddingBottom: theme.spacing.xxl,
      }}
      style={{ backgroundColor: theme.color.bg }}
    >
      {/* 个人信息区：有头像用头像，没有就用昵称首字——黑白模式下不显空 */}
      <View style={[styles.profile, { marginBottom: theme.spacing.lg }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="更换头像"
          onPress={() => void pickAvatar()}
          disabled={avatarBusy}
        >
          <View
            style={[
              styles.avatar,
              { backgroundColor: theme.color.accent, borderColor: theme.color.border },
            ]}
          >
            {avatarBusy ? (
              <ActivityIndicator color={theme.color.accentContrast} />
            ) : absoluteMediaUrl(baseUrl, profile?.avatarUrl) ? (
              <Image
                source={{ uri: absoluteMediaUrl(baseUrl, profile?.avatarUrl) as string }}
                style={styles.avatarImage}
                accessibilityLabel="当前头像"
              />
            ) : (
              <Text style={{ color: theme.color.accentContrast, fontSize: 24, fontWeight: '600' }}>
                {[...nickname][0] ?? '·'}
              </Text>
            )}
          </View>
          <View style={[styles.avatarBadge, { backgroundColor: theme.color.surfaceRaised }]}>
            <Ionicons name="camera-outline" size={14} color={theme.color.textSecondary} />
          </View>
        </Pressable>
        <View style={{ flex: 1, marginLeft: theme.spacing.md }}>
          <Text style={{ color: theme.color.textPrimary, fontSize: 22, fontWeight: '600' }} numberOfLines={1}>
            {nickname}
          </Text>
          <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginTop: 4 }}>
            {isOrg ? '组织身份' : '个人身份'} · 身份 #{session?.identityId ?? '-'}
          </Text>
          <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 2 }}>
            账号 #{session?.accountId ?? '-'}
          </Text>
          {avatarError ? (
            <Text style={{ color: theme.color.danger, fontSize: 12, marginTop: 4 }}>{avatarError}</Text>
          ) : null}
        </View>
      </View>

      <View style={{ marginBottom: theme.spacing.lg }}>
        <SectionHeader title="账号" />
        <ListGroup>
          <ListRow
            leading={<RowIcon name="swap-horizontal-outline" />}
            title="切换身份"
            subtitle={otherIdentityCount > 0 ? `还可切换 ${otherIdentityCount} 个身份` : '暂无其他身份'}
            onPress={onOpenIdentitySwitch}
            trailing={<Chevron />}
          />
        </ListGroup>
      </View>

      <View style={{ marginBottom: theme.spacing.lg }}>
        <SectionHeader title="偏好" />
        <ListGroup>
          <ListRow
            leading={<RowIcon name="moon-outline" />}
            title="深色模式"
            subtitle={scheme === 'dark' ? '已开启' : '跟随浅色'}
            trailing={
              <Switch
                value={scheme === 'dark'}
                onValueChange={toggleScheme}
                accessibilityLabel="深色模式"
                trackColor={{ false: theme.color.border, true: theme.color.accent }}
                thumbColor={theme.color.surfaceRaised}
              />
            }
          />
        </ListGroup>
      </View>

      <View style={{ marginBottom: theme.spacing.lg }}>
        <SectionHeader title="支持" />
        <ListGroup>
          <ListRow
            leading={<RowIcon name="chatbubble-ellipses-outline" />}
            title="意见反馈"
            subtitle="功能异常、体验建议都可以提"
            onPress={onOpenFeedback}
            trailing={<Chevron />}
          />
        </ListGroup>
      </View>

      <View style={{ marginBottom: theme.spacing.lg }}>
        <SectionHeader title="关于" />
        <ListGroup>
          <ListRow
            leading={<RowIcon name="link-outline" />}
            title="接口地址"
            subtitle={baseUrl}
          />
          <ListSeparator inset={52} />
          <ListRow leading={<RowIcon name="information-circle-outline" />} title="版本" subtitle="0.1.0" />
        </ListGroup>
      </View>

      <ListGroup>
        <ListRow
          leading={<RowIcon name="log-out-outline" tone="danger" />}
          title="退出登录"
          tone="danger"
          onPress={() => void logout()}
        />
      </ListGroup>
    </ScrollView>
  );
}

/** 行首图标：统一线性图标 + 统一的尺寸与颜色，避免每行各写一套。 */
function RowIcon({ name, tone = 'default' }: { name: string; tone?: 'default' | 'danger' }) {
  const theme = useAppTheme();
  return (
    <View style={styles.rowIcon}>
      <Ionicons
        name={name as never}
        size={20}
        color={tone === 'danger' ? theme.color.danger : theme.color.textSecondary}
      />
    </View>
  );
}

function Chevron() {
  const theme = useAppTheme();
  return <Text style={{ color: theme.color.textTertiary, fontSize: 16 }}>›</Text>;
}

const styles = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: { width: '100%', height: '100%' },
  avatarBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowIcon: { width: 36, alignItems: 'flex-start' },
});
