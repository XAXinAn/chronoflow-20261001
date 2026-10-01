import { useCallback, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { userFacingError } from '../domain/errors';
import { Card, PrimaryButton, Screen } from '../components/ui';
import { EditorHeader } from '../components/form';
import { WheelDatePicker } from '../components/WheelDatePicker';
import { WheelLayer } from '../components/WheelLayer';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { APP_TIMEZONE } from '../domain/calendar';
import { localDateKey } from '../domain/agenda';
import { buildDraftCreatePayload, draftDateKey, type RecognizedDraft } from '../domain/vision';

/**
 * 「图片识别日程」的**确认页**（spec §4.1.9）。
 *
 * 模型会看错，直接写进日历比看错更糟——所以识别结果一律先摆在这里：
 * 每条可改**标题**、补 / 改**日期**、删除；**所有条目都有日期**后底部「添加 N 条」才可点。
 * 日期用滚轮选（与「跳到指定日期」同一套交互），时刻固定 00:00（「就这一天」）——
 * 要精确到点，用户添加后在日历里再编辑。
 */

interface ImportRow {
  key: string;
  title: string;
  /** 选中的日期键（YYYY-MM-DD）；null = 通知里没写、用户还没补 */
  dateKey: string | null;
  timezone: string;
  locationName: string | null;
  description: string | null;
}

function todayKey(): string {
  return localDateKey(new Date().toISOString(), APP_TIMEZONE);
}

function formatDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  return `${year} 年 ${month} 月 ${day} 日`;
}

export function EventImportScreen({
  drafts,
  onCancel,
  onAdded,
}: {
  drafts: RecognizedDraft[];
  onCancel: () => void;
  /** 全部条目都写进日历后调用（返回日历页） */
  onAdded: () => void;
}) {
  const theme = useAppTheme();
  const { api } = useRuntime();
  const today = useMemo(todayKey, []);

  const [rows, setRows] = useState<ImportRow[]>(() =>
    drafts.map((draft, index) => ({
      key: `${index}-${draft.title}`,
      title: draft.title,
      dateKey: draftDateKey(draft),
      timezone: draft.timezone || APP_TIMEZONE,
      locationName: draft.locationName ?? null,
      description: draft.description ?? null,
    })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 正在给哪一条选日期（null = 没开）；连同滚轮里的草稿值一起存 */
  const [picker, setPicker] = useState<{ key: string; title: string; value: string } | null>(null);

  const missingDates = rows.filter((row) => !row.dateKey).length;
  const missingTitles = rows.filter((row) => !row.title.trim()).length;
  const canAdd = rows.length > 0 && missingDates === 0 && missingTitles === 0 && !saving;

  const patchRow = (key: string, patch: Partial<ImportRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setError(null);
  };

  const openPicker = (row: ImportRow) => {
    setPicker({ key: row.key, title: row.title, value: row.dateKey ?? today });
  };

  const confirmPicker = () => {
    if (picker) {
      patchRow(picker.key, { dateKey: picker.value });
    }
    setPicker(null);
  };

  const addAll = useCallback(async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    setError(null);
    // 逐条创建（顺序建，失败时能明确知道是哪几条没成），成功的从列表里去掉，
    // 只留失败的让用户重试——重试成功的那些再建一遍会变成重复日程
    const failed: ImportRow[] = [];
    const failures: string[] = [];
    for (const row of rows) {
      if (!row.dateKey || !row.title.trim()) {
        failed.push(row);
        continue;
      }
      try {
        await api.createEvent(
          buildDraftCreatePayload(
            {
              title: row.title,
              locationName: row.locationName,
              description: row.description,
            },
            row.dateKey,
            row.timezone,
          ),
        );
      } catch (cause) {
        failed.push(row);
        failures.push(`${row.title}：${userFacingError(cause, '创建失败')}`);
      }
    }
    setSaving(false);
    if (failed.length === 0) {
      onAdded();
      return;
    }
    setRows(failed);
    setError(`有 ${failed.length} 条没有添加成功：\n${failures.join('\n')}`);
  }, [api, onAdded, rows, saving]);

  const count = rows.length;

  return (
    <Screen>
      <EditorHeader
        title="识别到的日程"
        titleOnly
        // titleOnly 只用标题 + right 那一格；这两个回调在 titleOnly 下不会被渲染
        onCancel={onCancel}
        onSave={() => {}}
        right={
          <Pressable accessibilityRole="button" accessibilityLabel="取消" onPress={onCancel} hitSlop={10}>
            <Text style={{ color: theme.color.textSecondary, fontSize: 15 }}>取消</Text>
          </Pressable>
        }
      />

      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.md, paddingBottom: theme.spacing.xxl }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginBottom: theme.spacing.sm }}>
          核对一下：模型可能看错，确认或改好之后再添加。
        </Text>

        {rows.map((row) => {
          const missing = !row.dateKey;
          return (
            <View key={row.key} style={{ marginBottom: theme.spacing.sm }}>
              <Card>
                <View style={styles.titleRow}>
                  <TextInput
                    value={row.title}
                    onChangeText={(title) => patchRow(row.key, { title })}
                    placeholder="日程标题"
                    placeholderTextColor={theme.color.textTertiary}
                    accessibilityLabel="日程标题"
                    style={[styles.titleInput, { color: theme.color.textPrimary }]}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`删除-${row.title || '未命名'}`}
                    hitSlop={10}
                    onPress={() => setRows((current) => current.filter((item) => item.key !== row.key))}
                  >
                    <Ionicons name="trash-outline" size={18} color={theme.color.textTertiary} />
                  </Pressable>
                </View>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`日期-${row.title || '未命名'}`}
                  onPress={() => openPicker(row)}
                  style={styles.dateRow}
                >
                  <Text
                    style={{
                      // 没日期的那条标红，提示「请选择日期」——它就差这一步不能提交
                      color: missing ? theme.color.danger : theme.color.textPrimary,
                      fontSize: 15,
                    }}
                  >
                    {missing ? '请选择日期' : formatDateKey(row.dateKey as string)}
                  </Text>
                  <Ionicons name="chevron-forward" size={16} color={theme.color.textTertiary} />
                </Pressable>

                {row.description ? (
                  <Text
                    numberOfLines={2}
                    style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 6 }}
                  >
                    {row.description}
                  </Text>
                ) : null}
              </Card>
            </View>
          );
        })}

        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.sm }}>
            {error}
          </Text>
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { borderTopColor: theme.color.border }]}>
        {missingDates > 0 ? (
          <Text style={{ color: theme.color.danger, fontSize: 12, marginBottom: 8 }}>
            还有 {missingDates} 条没选日期
          </Text>
        ) : null}
        {missingTitles > 0 ? (
          <Text style={{ color: theme.color.danger, fontSize: 12, marginBottom: 8 }}>
            还有 {missingTitles} 条没填标题
          </Text>
        ) : null}
        <PrimaryButton
          title={saving ? '添加中…' : `添加 ${count} 条日程`}
          onPress={() => void addAll()}
          disabled={!canAdd}
          loading={saving}
        />
      </View>

      {picker ? (
        <WheelLayer
          title={`选择日期 · ${picker.title || '未命名'}`}
          onCancel={() => setPicker(null)}
          onConfirm={confirmPicker}
        >
          <WheelDatePicker
            value={picker.value}
            onChange={(value) => setPicker((current) => (current ? { ...current, value } : current))}
          />
        </WheelLayer>
      ) : null}

      {saving ? (
        <View style={styles.savingOverlay} pointerEvents="auto">
          <ActivityIndicator color={theme.color.accent} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  titleInput: { flex: 1, fontSize: 16, fontWeight: '600', paddingVertical: 2 },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.25)',
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  /** 添加时盖住整页，避免用户连点两次建出重复日程 */
  savingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
});
