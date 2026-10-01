import { useCallback, useEffect, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { userFacingError } from '../domain/errors';
import { Card, PrimaryButton, Screen } from '../components/ui';
import { EditorHeader } from '../components/form';
import { WheelDatePicker } from '../components/WheelDatePicker';
import { WheelLayer } from '../components/WheelLayer';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { APP_TIMEZONE } from '../domain/calendar';
import { localDateKey } from '../domain/agenda';
import { buildCreatePayload, type EventDraft } from '../domain/eventDraft';
import { draftDateKey, draftToEventDraft, type RecognizedDraft } from '../domain/vision';

/**
 * 「图片识别日程」的**确认页**（spec §4.1.9）。
 *
 * 模型会看错，直接写进日历比看错更糟——所以识别结果一律先摆在这里：
 * **点任意一条进整页编辑器**（`EventEditorScreen` 的草稿模式：标题 / 日期 / 时间 / 地点 /
 * 详细地址 / 备注 / 重复 / 提醒，和编辑日程一模一样，但不落库），也可以就地改日期、删除。
 * **所有条目都有日期**后底部「添加 N 条」才可点；逐条 `POST /events`，
 * 全部成功回日历，部分失败则只留失败的让用户重试（成功的不会重复创建）。
 */

interface ImportRow {
  key: string;
  /** 整份日程草稿（与编辑日程同一套字段），用户在编辑器里改的就是它 */
  draft: EventDraft;
  /** 这条草稿落在哪一天；null = 通知里没写日期、用户还没补 */
  dateKey: string | null;
}

/** 编辑器保存后回传的结果：按 key 把这些内容写回对应的那一行。 */
export interface DraftEdit {
  version: number;
  key: string;
  draft: EventDraft;
  dateKey: string;
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
  draftEdit,
  onEditDraft,
  onCancel,
  onAdded,
}: {
  drafts: RecognizedDraft[];
  /** 从草稿编辑器回来的结果（version 变了才生效，与编辑页的二级页回传同一套语义） */
  draftEdit?: DraftEdit | null;
  onEditDraft: (key: string, draft: EventDraft, dateKey: string | null) => void;
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
      draft: draftToEventDraft(draft),
      dateKey: draftDateKey(draft),
    })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 正在给哪一条选日期（null = 没开）；连同滚轮里的草稿值一起存 */
  const [picker, setPicker] = useState<{ key: string; title: string; value: string } | null>(null);

  const missingDates = rows.filter((row) => !row.dateKey).length;
  const missingTitles = rows.filter((row) => !row.draft.title.trim()).length;
  const canAdd = rows.length > 0 && missingDates === 0 && missingTitles === 0 && !saving;

  // 从草稿编辑器回来：把改好的草稿写回对应那一行
  useEffect(() => {
    if (!draftEdit || draftEdit.version === 0) {
      return;
    }
    setRows((current) =>
      current.map((row) =>
        row.key === draftEdit.key
          ? { ...row, draft: draftEdit.draft, dateKey: draftEdit.dateKey }
          : row,
      ),
    );
    setError(null);
  }, [draftEdit]);

  const openPicker = (row: ImportRow) => {
    setPicker({ key: row.key, title: row.draft.title, value: row.dateKey ?? today });
  };

  const confirmPicker = () => {
    if (picker) {
      setRows((current) =>
        current.map((row) => (row.key === picker.key ? { ...row, dateKey: picker.value } : row)),
      );
      setError(null);
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
      if (!row.dateKey || !row.draft.title.trim()) {
        failed.push(row);
        continue;
      }
      try {
        await api.createEvent({
          ...buildCreatePayload(row.dateKey, row.draft),
          timezone: APP_TIMEZONE,
        });
      } catch (cause) {
        failed.push(row);
        failures.push(`${row.draft.title}：${userFacingError(cause, '创建失败')}`);
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
          核对一下：模型可能看错，点某一条可以像编辑日程一样改它，改好之后再添加。
        </Text>

        {rows.map((row) => {
          const missing = !row.dateKey;
          return (
            <View key={row.key} style={{ marginBottom: theme.spacing.sm }}>
              {/* 整张卡片可点：进整页编辑器（草稿模式）。日期行与删除按钮各自吃掉自己的点击 */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`编辑草稿-${row.draft.title || '未命名'}`}
                onPress={() => onEditDraft(row.key, row.draft, row.dateKey)}
              >
                <Card>
                  <View style={styles.titleRow}>
                    <Text
                      style={[styles.title, { color: theme.color.textPrimary }]}
                      numberOfLines={2}
                    >
                      {row.draft.title || '未命名'}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`删除-${row.draft.title || '未命名'}`}
                      hitSlop={10}
                      onPress={() =>
                        setRows((current) => current.filter((item) => item.key !== row.key))
                      }
                    >
                      <Ionicons name="trash-outline" size={18} color={theme.color.textTertiary} />
                    </Pressable>
                  </View>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`日期-${row.draft.title || '未命名'}`}
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
                      {missing
                        ? '请选择日期'
                        : `${formatDateKey(row.dateKey as string)} · ${row.draft.time}`}
                    </Text>
                    <Ionicons name="chevron-forward" size={16} color={theme.color.textTertiary} />
                  </Pressable>

                  {row.draft.description ? (
                    <Text
                      numberOfLines={2}
                      style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 6 }}
                    >
                      {row.draft.description}
                    </Text>
                  ) : null}
                  {row.draft.place?.name ? (
                    <Text
                      numberOfLines={1}
                      style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 4 }}
                    >
                      地点：{row.draft.place.name}
                    </Text>
                  ) : null}
                </Card>
              </Pressable>
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
          title={`添加 ${count} 条日程`}
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
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  title: { flex: 1, fontSize: 16, fontWeight: '600' },
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
