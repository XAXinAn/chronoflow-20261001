import { useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ApiError } from '../api/client';
import { EditorHeader } from '../components/form';
import { Card, EmptyState, Pill } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import {
  confidenceLabel,
  createdSummary,
  draftKind,
  endAtOrDefault,
  parseEditedTime,
  taskDueAt,
  type RecognizedEventDraft,
} from '../domain/vision';
import { absoluteMediaUrl } from '../domain/media';

/**
 * 识别结果确认页（spec §4.1.9）。
 *
 * <p>**绝不自动落库，而且每条都可编辑**：模型给的标题/时间/归类/地点都可能差一点，
 * 用户改两个字就对了，让他重新手打一遍等于白识别。
 * 地点必须是**高德能定位到的**（§5.9）：匹配不到就留空，用户可以手动选或干脆不要。
 */
export function RecognizedEventsScreen({
  drafts,
  photoUri,
  sourceLabel,
  deviceFallbackReason,
  /** 用户在 LocationPicker 里选好的地点（带 version 表达「又选了一次」） */
  pickedPlace,
  onPickPlace,
  onBack,
  onCreated,
}: {
  drafts: RecognizedEventDraft[];
  photoUri: string;
  sourceLabel: string;
  deviceFallbackReason: string | null;
  pickedPlace: { version: number; index: number; place: RecognizedEventDraft['place'] } | null;
  onPickPlace: (index: number) => void;
  onBack: () => void;
  onCreated: (summary: string) => void;
}) {
  const theme = useAppTheme();
  const { api, baseUrl } = useRuntime();
  const [items, setItems] = useState<RecognizedEventDraft[]>(drafts);
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(drafts.map((_, index) => index)),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 从选点页回来：把地点并进对应那条（用 version 触发，而不是比值——连续选同一地点也要生效）
  const [placeVersion, setPlaceVersion] = useState(0);
  if (pickedPlace && pickedPlace.version !== placeVersion) {
    setPlaceVersion(pickedPlace.version);
    setItems((current) =>
      current.map((item, index) =>
        index === pickedPlace.index
          ? {
              ...item,
              place: pickedPlace.place,
              locationName: pickedPlace.place?.name ?? null,
              locationUnmatched: false,
            }
          : item,
      ),
    );
  }

  const patch = (index: number, next: Partial<RecognizedEventDraft>) =>
    setItems((current) => current.map((item, position) =>
      position === index ? { ...item, ...next } : item));

  const toggle = (index: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });

  /** 时间输入 → 存储值。填了但解析不出来就报错，绝不猜一个时间。 */
  const timeError = useMemo(() => {
    for (const [index, item] of items.entries()) {
      if (!selected.has(index)) {
        continue;
      }
      if (draftKind(item) === 'EVENT') {
        if (!item.startAt) {
          return `「${item.title}」还没有时间，请填写或取消勾选`;
        }
      }
    }
    return null;
  }, [items, selected]);

  const create = async () => {
    if (timeError) {
      setError(timeError);
      return;
    }
    setSaving(true);
    setError(null);
    let eventCount = 0;
    let taskCount = 0;
    try {
      for (const [index, item] of items.entries()) {
        if (!selected.has(index)) {
          continue;
        }
        if (draftKind(item) === 'EVENT' && item.startAt) {
          await api.createEvent({
            title: item.title,
            startAt: item.startAt,
            endAt: endAtOrDefault(item),
            allDay: Boolean(item.allDay),
            timezone: 'Asia/Shanghai',
            // 地点只写高德能定位的结构化结果（§5.9）：匹配不到就是空
            locationName: item.place?.name ?? null,
            locationAddress: item.place?.address ?? null,
            latitude: item.place?.latitude ?? null,
            longitude: item.place?.longitude ?? null,
            poiId: item.place?.poiId ?? null,
            description: item.description ?? null,
          });
          eventCount += 1;
        } else {
          await api.createTask({
            title: item.title,
            description: item.description ?? null,
            dueAt: taskDueAt(item),
          });
          taskCount += 1;
        }
      }
      onCreated(createdSummary(eventCount, taskCount));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建失败');
    } finally {
      setSaving(false);
    }
  };

  const photoSource =
    absoluteMediaUrl(baseUrl, photoUri.startsWith('file:') ? null : photoUri) ?? photoUri;

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <EditorHeader
        title="识别结果（可修改）"
        cancelLabel="返回"
        saveLabel="创建"
        savingLabel="创建中…"
        saving={saving}
        saveDisabled={selected.size === 0}
        onCancel={onBack}
        onSave={() => void create()}
      />

      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.md, gap: theme.spacing.md }}
        keyboardShouldPersistTaps="handled"
      >
        <Image
          source={{ uri: photoSource }}
          style={[styles.photo, { borderColor: theme.color.border }]}
          accessibilityLabel="刚识别的照片"
        />
        <Text style={{ color: theme.color.textTertiary, fontSize: 12 }}>
          {sourceLabel}
          {deviceFallbackReason ? `（${deviceFallbackReason}）` : ''}
        </Text>

        {items.length === 0 ? (
          <EmptyState title="这张图里没有识别到日程" hint="换一张更清晰的照片，或手动新建" />
        ) : null}

        {items.map((item, index) => {
          const kind = draftKind(item);
          return (
            <Card key={index}>
              <View style={styles.rowTop}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${item.title}-${selected.has(index) ? '已选' : '未选'}`}
                  onPress={() => toggle(index)}
                  hitSlop={8}
                >
                  <Text style={{ color: theme.color.accent, fontSize: 18 }}>
                    {selected.has(index) ? '☑' : '☐'}
                  </Text>
                </Pressable>

                {/* 归类可改：模型把「登记截止」判成日程时，用户点一下就能改回待办 */}
                <View style={styles.kindRow}>
                  {(['EVENT', 'TASK'] as const).map((value) => {
                    const active = kind === value;
                    return (
                      <Pressable
                        key={value}
                        accessibilityRole="button"
                        accessibilityLabel={value === 'EVENT' ? '日程' : '待办'}
                        onPress={() => patch(index, { kind: value })}
                        style={[
                          styles.kindChip,
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
                            fontSize: 12,
                          }}
                        >
                          {value === 'EVENT' ? '日程' : '待办'}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {confidenceLabel(item.confidence) ? (
                  <Pill text={confidenceLabel(item.confidence) as string} />
                ) : null}
              </View>

              <TextInput
                value={item.title}
                onChangeText={(text) => patch(index, { title: text })}
                accessibilityLabel="标题"
                placeholder="标题"
                placeholderTextColor={theme.color.textTertiary}
                style={[styles.input, { color: theme.color.textPrimary, borderColor: theme.color.border }]}
              />

              {kind === 'EVENT' ? (
                <View style={styles.timeRow}>
                  <TimeField
                    label="开始"
                    value={item.startAt}
                    onChange={(text) => patch(index, { startAt: parseEditedTime(text) ?? (text.trim() ? undefined : null) })}
                    rawKey={`start-${index}`}
                  />
                  <TimeField
                    label="结束"
                    value={item.endAt}
                    onChange={(text) => patch(index, { endAt: parseEditedTime(text) ?? (text.trim() ? undefined : null) })}
                    rawKey={`end-${index}`}
                  />
                </View>
              ) : (
                <TimeField
                  label="截止"
                  value={item.dueAt ?? item.startAt}
                  onChange={(text) => patch(index, { dueAt: parseEditedTime(text) })}
                  rawKey={`due-${index}`}
                />
              )}

              <View style={styles.locationRow}>
                <Text style={{ color: theme.color.textSecondary, fontSize: 13 }}>地点</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="选择地点"
                  onPress={() => onPickPlace(index)}
                  style={{ flex: 1 }}
                >
                  <Text
                    style={{
                      color: item.place ? theme.color.textPrimary : theme.color.textTertiary,
                      fontSize: 14,
                    }}
                  >
                    {item.place
                      ? item.place.name
                      : item.locationUnmatched
                        ? '未匹配到地点（已留空）'
                        : '未设置 · 点这里选'}
                  </Text>
                </Pressable>
                {item.place || item.locationUnmatched ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="清空地点"
                    onPress={() => patch(index, { place: null, locationName: null, locationUnmatched: false })}
                    hitSlop={8}
                  >
                    <Text style={{ color: theme.color.textTertiary, fontSize: 13 }}>清空</Text>
                  </Pressable>
                ) : null}
              </View>

              <TextInput
                value={item.description ?? ''}
                onChangeText={(text) => patch(index, { description: text })}
                accessibilityLabel="备注"
                placeholder="备注 / 原文要点"
                placeholderTextColor={theme.color.textTertiary}
                multiline
                style={[
                  styles.input,
                  styles.textarea,
                  { color: theme.color.textPrimary, borderColor: theme.color.border },
                ]}
              />
            </Card>
          );
        })}

        {error ? <Text style={{ color: theme.color.danger }}>{error}</Text> : null}
        {saving ? <ActivityIndicator color={theme.color.accent} /> : null}

        {items.length > 0 ? (
          <Pressable onPress={() => setSelected(new Set(items.map((_, index) => index)))}>
            <Text style={{ color: theme.color.accent, fontSize: 14 }}>全选</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** 时间输入：占位提示格式，用户改错时就保持原值不动（解析不了不硬塞）。 */
function TimeField({
  label,
  value,
  onChange,
  rawKey,
}: {
  label: string;
  value?: string | null;
  onChange: (text: string) => void;
  rawKey: string;
}) {
  const theme = useAppTheme();
  const [text, setText] = useState(formatForEdit(value));

  return (
    <View style={{ flex: 1 }}>
      <Text style={{ color: theme.color.textSecondary, fontSize: 12 }}>{label}</Text>
      <TextInput
        key={rawKey}
        value={text}
        onChangeText={(next) => {
          setText(next);
          onChange(next);
        }}
        accessibilityLabel={label}
        placeholder="2026-09-26 15:00"
        placeholderTextColor={theme.color.textTertiary}
        style={[styles.input, { color: theme.color.textPrimary, borderColor: theme.color.border }]}
      />
    </View>
  );
}

/** ISO → 可读可改的形式（本地时区展示，避免用户看到 UTC 少 8 小时）。 */
function formatForEdit(iso?: string | null): string {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  // 统一按东八区展示：与 App 其它页面的时间口径一致
  const shanghai = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${shanghai.getUTCFullYear()}-${pad(shanghai.getUTCMonth() + 1)}-${pad(shanghai.getUTCDate())} ${pad(shanghai.getUTCHours())}:${pad(shanghai.getUTCMinutes())}`;
}

const styles = StyleSheet.create({
  photo: {
    width: '100%',
    height: 160,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    resizeMode: 'cover',
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  kindRow: { flexDirection: 'row', gap: 6, flex: 1 },
  kindChip: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    marginTop: 8,
  },
  textarea: { minHeight: 56, textAlignVertical: 'top' },
  timeRow: { flexDirection: 'row', gap: 10 },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
});
