import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { ApiError } from '../api/client';
import type { OrgCurrent, OrgEvent } from '../api/types';
import { EditorHeader, FormInput, FormRow, FormRowText, FormTextArea } from '../components/form';
import { Card, Screen } from '../components/ui';
import { useAppSessionState, useAppTheme } from '../context/AppContext';
import { timeInZone } from '../domain/eventDraft';
import {
  buildDispatchPayload,
  buildUpdatePayload,
  canDispatch,
  validateDispatchForm,
  withStartTime,
  type DispatchForm,
} from '../domain/orgDispatch';

/**
 * 新建组织日程（spec §4.2.2 / §4.2.3）。
 *
 * 和「日历」页的新建一样是整页（§4.1.5）。这一页只填日程本身；**下发对象**在选人页里挑
 * （点那一行 push 进去），回来只带回一份人名单——选人值得单独一页。
 *
 * 权限：能不能进这一页由组织页的悬浮按钮决定（一个可下发的人都没有时按钮不出现）；
 * 这里再兜一层：拿不到组织上下文、或组织里确实没有可下发的人，就不让提交。
 */
export function OrgEventEditorScreen({
  dateKey,
  event,
  selectedMemberIds,
  onPickRecipients,
  onCancel,
  onSaved,
}: {
  dateKey: string;
  /** 传了就是编辑模式：只有发起人能进来（`canEdit` 由服务端给，spec §4.2.2） */
  event?: OrgEvent;
  /** 选人页回填的下发对象（成员 id 列表） */
  selectedMemberIds: number[];
  onPickRecipients: () => void;
  onCancel: () => void;
  onSaved: (summary: string) => void;
}) {
  const theme = useAppTheme();
  const isEdit = Boolean(event);
  const { orgApi, activeOrgIdentityId } = useAppSessionState();
  const api = activeOrgIdentityId != null ? orgApi(activeOrgIdentityId) : null;

  const [org, setOrg] = useState<OrgCurrent | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<DispatchForm>({
    title: event?.title ?? '',
    description: event?.description ?? '',
    location: event?.location ?? '',
    locationDetail: event?.locationDetail ?? '',
    dateKey,
    allDay: event?.allDay ?? false,
    startTime: event ? timeInZone(event.startAt, event.timezone || 'Asia/Shanghai') : '09:00',
    endTime: event ? timeInZone(event.endAt, event.timezone || 'Asia/Shanghai') : '10:00',
    memberIds: [],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (next: Partial<DispatchForm>) => setForm((current) => ({ ...current, ...next }));
  /** 下发对象由上层持有（选人页回填），每次渲染同步进来 */
  const recipients = selectedMemberIds;

  const loadOrg = async () => {
    if (!api) {
      setLoading(false);
      setError('组织身份不可用，请重新进入组织');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setOrg(await api.orgCurrent());
    } catch (cause) {
      // 留下日志：这条失败会直接表现为「没法下发」，不留痕迹很难查（实测踩过一次）
      console.warn('[org-event-editor] 组织上下文加载失败', cause);
      setError(cause instanceof ApiError ? cause.message : '组织信息加载失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOrg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const canSubmit = Boolean(api && org && canDispatch(org));

  /** 撤回 / 删除是同一套收尾：成功后回到组织页（列表会在重新聚焦时刷新）。 */
  const mutate = async (action: () => Promise<unknown>, done: string) => {
    try {
      await action();
      onSaved(done);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '操作失败');
    }
  };

  const save = async () => {
    if (!api || !org) {
      setError('组织上下文还没准备好');
      return;
    }
    if (isEdit && event) {
      const checked = validateDispatchForm({ ...form, memberIds: [1] });
      if (!checked.ok) {
        setError(checked.message);
        return;
      }
      setSaving(true);
      setError(null);
      try {
        await api.updateOrgEvent(
          event.eventId,
          buildUpdatePayload(form, org.orgTimezone || 'Asia/Shanghai'),
        );
        onSaved(`「${form.title.trim()}」已更新，收件人看到的还是同一条`);
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : '保存失败');
      } finally {
        setSaving(false);
      }
      return;
    }
    const checked = validateDispatchForm({ ...form, memberIds: recipients });
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = buildDispatchPayload(
        { ...form, memberIds: recipients },
        org.orgTimezone || 'Asia/Shanghai',
      );
      await api.dispatchOrgEvent(payload);
      // 服务端保证发起人也在名单里（spec §4.2.2），提示里说清楚，免得用户以为漏了自己
      onSaved(`「${payload.title}」已下发给 ${recipients.length} 人（含你自己）`);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '下发失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <EditorHeader
        title={isEdit ? '编辑组织日程' : '新建组织日程'}
        saveLabel={isEdit ? '保存' : '下发'}
        savingLabel={isEdit ? '保存中…' : '下发中…'}
        onCancel={onCancel}
        onSave={() => void save()}
        saving={saving}
        saveDisabled={!canSubmit}
      />

      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.md, paddingBottom: theme.spacing.xxl }}
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          <FormInput
            value={form.title}
            onChangeText={(title) => patch({ title })}
            placeholder="日程标题"
            accessibilityLabel="日程标题"
            fontSize={18}
            autoFocus
          />
        </Card>

        <View style={{ marginTop: theme.spacing.md }}>
          <Card>
            <FormRow label="日期">
              <Text style={{ color: theme.color.textPrimary, fontSize: 15 }}>{form.dateKey}</Text>
            </FormRow>
            <FormRow label="全天">
              <Switch
                value={form.allDay}
                onValueChange={(allDay) => patch({ allDay })}
                accessibilityLabel="全天"
                trackColor={{ false: theme.color.border, true: theme.color.accent }}
                thumbColor={theme.color.surfaceRaised}
              />
            </FormRow>
            {!form.allDay ? (
              <>
                <FormRow label="开始">
                  <FormRowText
                    value={form.startTime}
                    placeholder="09:00"
                    onChangeText={(startTime) => setForm(withStartTime(form, startTime))}
                  />
                </FormRow>
                <FormRow label="结束">
                  <FormRowText
                    value={form.endTime}
                    placeholder="10:00"
                    onChangeText={(endTime) => patch({ endTime })}
                  />
                </FormRow>
              </>
            ) : null}
            <FormRow label="地点">
              <FormRowText
                value={form.location}
                placeholder="选填"
                onChangeText={(location) => patch({ location })}
              />
            </FormRow>
            {/* 地图只到「教学楼」时，教室号靠这一行补（spec §5.9） */}
            <FormRow label="详细地址" last>
              <FormRowText
                value={form.locationDetail}
                placeholder="3 号楼 305（选填）"
                onChangeText={(locationDetail) => patch({ locationDetail })}
              />
            </FormRow>
          </Card>
        </View>

        <View style={{ marginTop: theme.spacing.md }}>
          <Card>
            <FormTextArea
              value={form.description}
              placeholder="说明（选填）：会议议程、注意事项"
              onChangeText={(description) => patch({ description })}
            />
          </Card>
        </View>

        <Text style={[styles.sectionTitle, { color: theme.color.textSecondary }]}>下发对象</Text>
        <Card>
          {isEdit ? (
            <FormRow label="下发给" last>
              <Text style={{ color: theme.color.textSecondary, fontSize: 14, flex: 1, textAlign: 'right' }}>
                已发出的名单不可修改
              </Text>
            </FormRow>
          ) : loading ? (
            <Text style={{ color: theme.color.textSecondary, fontSize: 14 }}>正在读取组织信息…</Text>
          ) : !canSubmit ? (
            <View>
              <Text style={{ color: theme.color.danger, fontSize: 14 }}>
                {org ? '你在当前组织里没有可下发的人。' : '组织信息没取到，暂时无法下发。'}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="重新加载组织信息"
                onPress={() => void loadOrg()}
                style={{ marginTop: 10 }}
              >
                <Text style={{ color: theme.color.accent, fontSize: 15 }}>重新加载</Text>
              </Pressable>
            </View>
          ) : (
            <FormRow label="下发给" onPress={onPickRecipients} last>
              <Text
                style={{
                  color: recipients.length ? theme.color.textPrimary : theme.color.textTertiary,
                  fontSize: 15,
                  flex: 1,
                  textAlign: 'right',
                }}
              >
                {recipients.length ? `已选 ${recipients.length} 人` : '选择人员'}
              </Text>
              <Text style={{ color: theme.color.textTertiary, fontSize: 16, marginLeft: 6 }}>›</Text>
            </FormRow>
          )}
        </Card>

        {error ? (
          <Text style={{ color: theme.color.danger, marginTop: theme.spacing.md }}>{error}</Text>
        ) : null}

        {/* 编辑模式下的破坏性操作：撤回（成员端不再展示，已有回执时服务端会拒绝）与删除 */}
        {isEdit && event ? (
          <View style={{ marginTop: theme.spacing.lg, gap: theme.spacing.sm }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="撤回下发"
              onPress={() =>
                Alert.alert('撤回下发？', '撤回后成员不再看到这条日程；已有成员回执时无法撤回。', [
                  { text: '取消', style: 'cancel' },
                  {
                    text: '撤回',
                    style: 'destructive',
                    onPress: () => void mutate(() => api!.revokeOrgEvent(event.eventId), '已撤回'),
                  },
                ])
              }
            >
              <Text style={{ color: theme.color.accent, fontSize: 15, textAlign: 'center' }}>
                撤回下发
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="删除组织日程"
              onPress={() =>
                Alert.alert('删除这条组织日程？', '删除后成员端不再展示，且无法恢复。', [
                  { text: '取消', style: 'cancel' },
                  {
                    text: '删除',
                    style: 'destructive',
                    onPress: () => void mutate(() => api!.deleteOrgEvent(event.eventId), '已删除'),
                  },
                ])
              }
            >
              <Text style={{ color: theme.color.danger, fontSize: 15, textAlign: 'center' }}>
                删除
              </Text>
            </Pressable>
          </View>
        ) : null}

        <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: theme.spacing.sm }}>
          {isEdit
            ? '只有下发者本人能修改这条日程，其他成员只读。'
            : '下发后选中的成员会在各自的组织日历里看到它；你自己也会收到（发起人始终在名单内）。'}
        </Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
});
