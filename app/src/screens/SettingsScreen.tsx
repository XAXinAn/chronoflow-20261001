import { useCallback, useEffect, useRef, useState } from 'react';
import { userFacingError } from '../domain/errors';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';

import type { IdentityView } from '../api/types';
import { ListGroup, ListRow, ListSeparator, SectionHeader } from '../components/list';
import { askPermission } from '../components/permission';
import { useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import type { SettingsSectionKey } from './SettingsSectionScreen';
import { absoluteMediaUrl } from '../domain/media';
import { displayName } from '../domain/profile';

/**
 * 「我的」页。
 *
 * 结构对齐商用 App 的通行做法：**顶部个人信息区 + 若干带图标的分组列表**。
 * 之前那版是一行行纯文字，读起来像配置文件——分组、图标、层级都是靠视觉建立的，
 * 不该让用户去逐行读文字。
 */
export function SettingsScreen({
  onOpenProfileEdit,
  onOpenAvatarCrop,
  onOpenSection,
  avatarCrop,
}: {
  /** 改名字（昵称）：昵称是身份级属性，服务端支持 PATCH /me */
  onOpenProfileEdit: () => void;
  /** 打开某一类设置的独立子页（账号与安全 / 偏好 / 支持 / 隐私与合规 / 关于） */
  onOpenSection: (section: SettingsSectionKey) => void;
  /** 选好图后进取景页（正方框 + 拖动缩放，spec §4.1.8） */
  onOpenAvatarCrop: (uri: string) => void;
  /** 取景页裁完回传的本地图片；version 变了才上传（与地点/重复那套回传同一语义） */
  avatarCrop?: { version: number; uri: string | null } | null;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();

  // 各分类的内容（深色模式、到点提醒、检查更新、合规文档…）都在 SettingsSectionScreen 里；
  // 这一页只负责「头像 + 五个入口 + 退出登录」。
  const { api, baseUrl } = useRuntime();
  const { session, signOut } = useAppSessionState();

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
   * 换头像：选图 → **取景页裁成 1:1** → 上传拿到相对 URL → PATCH /me 回填（spec §4.1.8）。
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
      // 仍然不开 allowsEditing：系统裁剪页的确认按钮在 AOSP/部分机型上渲染不出来
      // （实测只有翻转菜单，用户会卡在里面出不来）。取景用我们自己的 `AvatarCropScreen`，
      // 行为一致、也照得到黑白极简的样式。
      quality: 0.8,
    });
    if (picked.canceled || picked.assets.length === 0) {
      return;
    }
    // 进自己的取景页：非 1:1 的图直接上传会被圆形容器裁掉两边
    onOpenAvatarCrop(picked.assets[0].uri);
  };

  /** 取景页裁完的图：上传 + 回填资料。 */
  const uploadAvatar = async (uri: string) => {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const uploaded = await api.uploadImage(uri);
      setProfile(await api.updateMe({ avatarUrl: uploaded.url }));
    } catch (cause) {
      // 非 ApiError 说明请求根本没到服务端（典型是 RN 的 fetch 在 multipart 上出错），
      // 这时把原始信息留下来，否则排查只能靠猜。
      // 用 log 而不是 warn：warn 在 Expo Go 里会弹黄框盖住界面，那是给开发看的，不该出现在用户面前。
      console.log('[avatar] 上传/更新失败', cause);
      setAvatarError(userFacingError(cause, '头像更新失败，请稍后再试'));
    } finally {
      setAvatarBusy(false);
    }
  };

  // 取景页回来：version 变了才上传（首次渲染 version=0 不动作）
  const uploadedCropVersion = useRef(0);
  useEffect(() => {
    const version = avatarCrop?.version ?? 0;
    if (version === 0 || version === uploadedCropVersion.current || !avatarCrop?.uri) {
      return;
    }
    uploadedCropVersion.current = version;
    void uploadAvatar(avatarCrop.uri);
    // uploadAvatar 每次渲染都是新函数，这里只认 version 的变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarCrop?.version]);

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

  const nickname = displayName(session?.nickname);

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
          {/*
            名字可点进去改（真机反馈「名字无法编辑」）。以前这里是一段死文字：
            服务端早就支持 PATCH /me 改昵称，界面上却没有入口。
          */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="修改名字"
            onPress={onOpenProfileEdit}
            hitSlop={6}
            style={styles.nameRow}
          >
            <Text
              style={{ color: theme.color.textPrimary, fontSize: 22, fontWeight: '600' }}
              numberOfLines={1}
            >
              {nickname}
            </Text>
            <Ionicons name="pencil-outline" size={16} color={theme.color.textTertiary} />
          </Pressable>
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


          <SectionHeader title="设置" />
          <ListGroup>
            <ListRow
              leading={<RowIcon name="shield-checkmark-outline" />}
              title="账号与安全"
              subtitle="实名认证、邮箱、账号注销"
              onPress={() => onOpenSection('account')}
            />
            <ListSeparator inset={52} />
            <ListRow
              leading={<RowIcon name="options-outline" />}
              title="偏好"
              subtitle="深色模式、到点提醒"
              onPress={() => onOpenSection('preferences')}
            />
            <ListSeparator inset={52} />
            <ListRow
              leading={<RowIcon name="chatbubble-ellipses-outline" />}
              title="支持"
              subtitle="意见反馈、检查更新"
              onPress={() => onOpenSection('support')}
            />
            <ListSeparator inset={52} />
            {/*
              隐私与合规常驻入口（规范 §四）：主界面 →「我的」→ 这一组 → 具体条文，共 3 步，
              满足「从主界面到隐私政策常驻入口不得超过 4 步」——分类入口也**没有**多一步。
            */}
            <ListRow
              leading={<RowIcon name="document-text-outline" />}
              title="隐私与合规"
              subtitle="隐私政策、用户协议、儿童声明、两份清单"
              onPress={() => onOpenSection('legal')}
            />
            <ListSeparator inset={52} />
            <ListRow
              leading={<RowIcon name="information-circle-outline" />}
              title="关于"
              subtitle="运营主体、版本"
              onPress={() => onOpenSection('about')}
            />
          </ListGroup>
      {/* 退出登录留在主页：它不属于任何一类设置，放子页里用户反而找不到 */}
      <View style={{ height: theme.spacing.lg }} />
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


const styles = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center' },
  /** 名字 + 铅笔图标：一眼看出这行能点（纯文字没人会去点） */
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
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
