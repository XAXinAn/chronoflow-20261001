import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';

import { ApiError } from '../api/client';
import type { FeedbackCategory, FeedbackItem } from '../api/types';
import { EditorHeader, FormTextArea } from '../components/form';
import { ListGroup, ListRow, ListSeparator, SectionHeader } from '../components/list';
import { Card, EmptyState, Pill, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_MAX_IMAGES,
  feedbackCategoryLabel,
  feedbackStatusLabel,
  feedbackSubmitError,
} from '../domain/feedback';
import { absoluteMediaUrl } from '../domain/media';

/**
 * 意见反馈（spec §4.1.9）。
 *
 * 分类 + 文字（必填）+ 可选多图，提交给平台超管；用户端只提交与查看自己的历史，
 * 不展示处理过程。
 */
export function FeedbackScreen({ onBack }: { onBack: () => void }) {
  const theme = useAppTheme();
  const { api, baseUrl } = useRuntime();

  const [category, setCategory] = useState<FeedbackCategory>('BUG');
  const [content, setContent] = useState('');
  /** 已上传图片的**相对 URL**（不是本地 uri）：提交时服务端只接受上传通道产出的地址 */
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<FeedbackItem[]>([]);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await api.myFeedback());
    } catch {
      // 历史拉不到不影响提交；提交成功后会再拉一次
    }
  }, [api]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const addImages = async () => {
    setError(null);
    setNotice(null);
    if (images.length >= FEEDBACK_MAX_IMAGES) {
      setError(`最多添加 ${FEEDBACK_MAX_IMAGES} 张图片`);
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError('需要相册权限才能添加图片');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: FEEDBACK_MAX_IMAGES - images.length,
      quality: 0.8,
    });
    if (picked.canceled || picked.assets.length === 0) {
      return;
    }

    setUploading(true);
    try {
      const uploaded: string[] = [];
      for (const asset of picked.assets) {
        const result = await api.uploadImage(asset.uri);
        uploaded.push(result.url);
      }
      setImages((current) => [...current, ...uploaded].slice(0, FEEDBACK_MAX_IMAGES));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '图片上传失败');
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    const invalid = feedbackSubmitError(content);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await api.submitFeedback({ category, content: content.trim(), images });
      // 清空表单但保留分类：连着提两条同类问题时不用再选一次
      setContent('');
      setImages([]);
      setNotice('已提交，我们会尽快查看');
      await loadHistory();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen>
      <EditorHeader
        title="意见反馈"
        cancelLabel="返回"
        saveLabel="提交"
        savingLabel="提交中…"
        saving={submitting}
        saveDisabled={uploading}
        onCancel={onBack}
        onSave={() => void submit()}
      />

      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.md, paddingBottom: theme.spacing.xxl }}
        keyboardShouldPersistTaps="handled"
      >
        <SectionHeader title="分类" />
        <View style={styles.chips}>
          {FEEDBACK_CATEGORIES.map((item) => {
            const active = item.value === category;
            return (
              <Pressable
                key={item.value}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={item.label}
                onPress={() => setCategory(item.value)}
                style={[
                  styles.chip,
                  {
                    borderColor: active ? theme.color.accent : theme.color.border,
                    backgroundColor: active ? theme.color.accent : 'transparent',
                    borderRadius: theme.radius.tag,
                  },
                ]}
              >
                <Text
                  style={{
                    color: active ? theme.color.accentContrast : theme.color.textSecondary,
                    fontSize: 14,
                  }}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={{ marginTop: theme.spacing.lg }}>
          <SectionHeader title="描述" caption="必填" />
          <Card>
            <FormTextArea
              value={content}
              placeholder="遇到了什么问题？或者希望我们改进什么？"
              onChangeText={setContent}
            />
          </Card>
        </View>

        <View style={{ marginTop: theme.spacing.lg }}>
          <SectionHeader title="图片" caption={`${images.length}/${FEEDBACK_MAX_IMAGES} · 可选`} />
          <View style={styles.thumbnails}>
            {images.map((url) => (
              <View key={url} style={styles.thumbnailWrapper}>
                <Image
                  source={{ uri: absoluteMediaUrl(baseUrl, url) as string }}
                  style={[styles.thumbnail, { borderColor: theme.color.border }]}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="移除这张图片"
                  onPress={() => setImages((current) => current.filter((item) => item !== url))}
                  style={[styles.remove, { backgroundColor: theme.color.surfaceRaised }]}
                >
                  <Ionicons name="close" size={14} color={theme.color.textSecondary} />
                </Pressable>
              </View>
            ))}
            {images.length < FEEDBACK_MAX_IMAGES ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="添加图片"
                onPress={() => void addImages()}
                disabled={uploading}
                style={[styles.addImage, { borderColor: theme.color.border }]}
              >
                {uploading ? (
                  <ActivityIndicator color={theme.color.textSecondary} />
                ) : (
                  <Ionicons name="add" size={22} color={theme.color.textSecondary} />
                )}
              </Pressable>
            ) : null}
          </View>
        </View>

        {error ? (
          <Text style={{ color: theme.color.danger, marginTop: theme.spacing.md }}>{error}</Text>
        ) : null}
        {notice ? (
          <Text style={{ color: theme.color.success, marginTop: theme.spacing.md }}>{notice}</Text>
        ) : null}

        <View style={{ marginTop: theme.spacing.xl }}>
          <SectionHeader title="我提交过的" caption={history.length > 0 ? `共 ${history.length} 条` : undefined} />
          {history.length === 0 ? (
            <EmptyState title="还没有提交过反馈" hint="提交后可以在这里回看" />
          ) : (
            <ListGroup>
              {history.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <ListSeparator /> : null}
                  <ListRow
                    title={item.content}
                    subtitle={`${feedbackCategoryLabel(item.category)} · ${formatSubmittedAt(item.createdAt)}`}
                    trailing={<Pill text={feedbackStatusLabel(item.status)} />}
                  />
                </View>
              ))}
            </ListGroup>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

/** 提交时间按 App 统一时区展示，避免设备时区一变就与其它页矛盾。 */
function formatSubmittedAt(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', gap: 8 },
  chip: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
  thumbnails: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  thumbnailWrapper: { position: 'relative' },
  thumbnail: { width: 72, height: 72, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  remove: {
    position: 'absolute',
    right: -6,
    top: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addImage: {
    width: 72,
    height: 72,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
