import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';

import { ApiError } from '../api/client';
import type { IdentityView } from '../api/types';
import { ListGroup, ListRow, ListSeparator, SectionHeader } from '../components/list';
import { askPermission } from '../components/permission';
import { useAppScheme, useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import { LEGAL_DOCS, OPERATOR_NAME, APP_VERSION, type LegalDoc } from '../domain/legal';
import { absoluteMediaUrl } from '../domain/media';

/**
 * 「我的」页。
 *
 * 结构对齐商用 App 的通行做法：**顶部个人信息区 + 若干带图标的分组列表**。
 * 之前那版是一行行纯文字，读起来像配置文件——分组、图标、层级都是靠视觉建立的，
 * 不该让用户去逐行读文字。
 */
export function SettingsScreen({
  onOpenFeedback,
  onOpenLegal,
  onOpenDeletion,
}: {
  onOpenFeedback: () => void;
  /** 打开隐私政策 / 用户协议 / 儿童声明 / 双清单（规范 §四「隐私政策常驻入口」） */
  onOpenLegal: (doc: LegalDoc) => void;
  onOpenDeletion: () => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const scheme = useAppScheme();
  const { api, baseUrl } = useRuntime();
  const { session, toggleScheme, signOut, notificationEnabled, setNotificationEnabled } =
    useAppSessionState();

  /**
   * 当前身份信息从服务端读，而不是只在本地会话里取：
   * 头像是身份级属性（spec §4.1.8），本地会话缓存里没有它，重启后也必须还在。
   */
  const [profile, setProfile] = useState<IdentityView | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const loadProfile = useCallback(async () => {
    try {
      setProfile(await api.me());
    } catch {
      // 资料拿不到不影响本页其他内容（会话里还有昵称）
    }
  }, [api]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  /**
   * 换头像：选图 → 上传拿到相对 URL → PATCH /me 回填（spec §4.1.8）。
   *
   * 顺序不能反：先上传再写资料，中途失败最多留一张没人引用的图片（无害），
   * 反过来会写出一个指向不存在文件的 avatarUrl，界面上就是一个永远加载不出来的头像。
   */
  const pickAvatar = async () => {
    setAvatarError(null);
    // 先说明用途再申请系统权限，拒绝后只是不换头像（规范 §四「频繁、过度索取权限」）
    if (!(await askPermission('photo'))) {
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

  const nickname = session?.nickname ?? '未命名';

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
          {/*
            这里原来还有两行「个人身份 · 身份 #1」「账号 #1」。
            身份 ID / 账号 ID 是内部标识：用户看不懂、也没法拿它做任何事，
            真要排查问题让他报手机号就够了。「个人身份 / 组织身份」也一并去掉 ——
            那是我们的数据模型术语，用户视角只有「我在用哪个账号」，
            而当前组织在「组织」tab 顶部已经写清楚。
          */}
          {avatarError ? (
            <Text style={{ color: theme.color.danger, fontSize: 12, marginTop: 4 }}>{avatarError}</Text>
          ) : null}
        </View>
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
          {/*
            到点提醒的总开关（spec §4.5）。
            关掉时不只是「以后不排」：已排的本机通知也会被撤掉（见 refreshLocalReminders），
            否则用户关掉之后照样被提醒，那个开关就成了摆设。
          */}
          <ListRow
            leading={<RowIcon name="notifications-outline" />}
            title="到点提醒"
            subtitle={notificationEnabled ? '日程与待办会按时提醒' : '已关闭，到点不会提醒'}
            trailing={
              <Switch
                value={notificationEnabled}
                onValueChange={setNotificationEnabled}
                accessibilityLabel="到点提醒"
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
            onPress={onOpenFeedback}
            trailing={<Chevron />}
          />
        </ListGroup>
      </View>

      {/*
        隐私与合规常驻入口（规范 §四）：主界面 →「我的」→ 这一组 → 具体条文，共 3 步，
        满足「从主界面到隐私政策常驻入口不得超过 4 步」。
        这些页面都是 WebView 打开服务端同一份文本，因此与商店后台提交的链接逐字一致。
      */}
      <View style={{ marginBottom: theme.spacing.lg }}>
        <SectionHeader title="隐私与合规" />
        <ListGroup>
          <ListRow
            leading={<RowIcon name="document-text-outline" />}
            title={LEGAL_DOCS['privacy-policy'].title}
            subtitle="我们收集什么、怎么用、怎么删"
            onPress={() => onOpenLegal('privacy-policy')}
            trailing={<Chevron />}
          />
          <ListSeparator inset={52} />
          <ListRow
            leading={<RowIcon name="reader-outline" />}
            title={LEGAL_DOCS['user-agreement'].title}
            onPress={() => onOpenLegal('user-agreement')}
            trailing={<Chevron />}
          />
          <ListSeparator inset={52} />
          <ListRow
            leading={<RowIcon name="shield-checkmark-outline" />}
            title={LEGAL_DOCS['children-privacy'].title}
            onPress={() => onOpenLegal('children-privacy')}
            trailing={<Chevron />}
          />
          <ListSeparator inset={52} />
          <ListRow
            leading={<RowIcon name="list-outline" />}
            title={LEGAL_DOCS['personal-info-collected'].title}
            onPress={() => onOpenLegal('personal-info-collected')}
            trailing={<Chevron />}
          />
          <ListSeparator inset={52} />
          <ListRow
            leading={<RowIcon name="share-social-outline" />}
            title={LEGAL_DOCS['shared-info-with-third-parties'].title}
            subtitle="高德地图、短信服务"
            onPress={() => onOpenLegal('shared-info-with-third-parties')}
            trailing={<Chevron />}
          />
          <ListSeparator inset={52} />
          <ListRow
            leading={<RowIcon name="trash-outline" tone="danger" />}
            title="账号注销"
            subtitle="删除个人信息并停用账号"
            tone="danger"
            onPress={onOpenDeletion}
            trailing={<Chevron />}
          />
        </ListGroup>
      </View>

      <View style={{ marginBottom: theme.spacing.lg }}>
        <SectionHeader title="关于" />
        <ListGroup>
          <ListRow
            leading={<RowIcon name="business-outline" />}
            title="运营主体"
            subtitle={OPERATOR_NAME}
          />
          <ListSeparator inset={52} />
          {/*
            接口地址那一行删掉了。原先的判断是「只在 __DEV__ 显示」，但 Expo Go / dev client
            里 __DEV__ 恒为 true —— 于是演示包里用户照样看到 `http://<ip>:8080`：
            对用户是无意义的噪音，对我们则是白送一次后端地址的侦察。
            开发需要看地址时读 app.json / .env.local 即可，不必摆在界面上。
          */}
          <ListRow leading={<RowIcon name="information-circle-outline" />} title="版本" subtitle={APP_VERSION} />
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
