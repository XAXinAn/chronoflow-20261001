import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError } from '../api/client';
import type { OrgCurrent, OrgDepartmentNode, OrgMemberItem } from '../api/types';
import { EditorHeader } from '../components/form';
import { Card, EmptyState, Screen } from '../components/ui';
import { useAppSessionState, useAppTheme } from '../context/AppContext';
import {
  addIds,
  buildRecipientGroups,
  filterRecipientGroups,
  isGroupFullySelected,
  removeIds,
  toggleId,
} from '../domain/orgRecipients';

/**
 * 选择下发对象（spec §4.2.2「下发对象 = 选人」）。
 *
 * 为什么单独一页：组织一大，选人就是这个流程里最重的一步——要按组织单位分组、要能搜、
 * 要能整部门快速勾、还要能看见自己已经选了谁。塞进编辑页的一小块区域里，这四件事都做不好。
 */
export function OrgRecipientPickerScreen({
  initialSelected,
  onCancel,
  onConfirm,
}: {
  initialSelected: number[];
  onCancel: () => void;
  onConfirm: (memberIds: number[]) => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  // 用当前组织的令牌取人：能选到谁，服务端已经按身份收敛过（spec §4.2.2）
  const { orgApi, activeOrgIdentityId } = useAppSessionState();
  const api = activeOrgIdentityId != null ? orgApi(activeOrgIdentityId) : null;

  const [members, setMembers] = useState<OrgMemberItem[]>([]);
  const [tree, setTree] = useState<OrgDepartmentNode[]>([]);
  const [org, setOrg] = useState<OrgCurrent | null>(null);
  const [selected, setSelected] = useState<number[]>(initialSelected);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) {
      setLoading(false);
      setError('组织身份不可用，请重新进入组织');
      return;
    }
    let active = true;
    void (async () => {
      try {
        const [list, departments, current] = await Promise.all([
          api.orgMembers(),
          api.orgDepartments(),
          api.orgCurrent(),
        ]);
        if (!active) {
          return;
        }
        setMembers(list);
        setTree(departments);
        setOrg(current);
      } catch (cause) {
        console.warn('[org-recipients] 成员/部门加载失败', cause);
        if (active) {
          setError(cause instanceof ApiError ? cause.message : '成员列表加载失败，请重试');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

  // 只列出「我有权下发」的人：没权限的人在这里就不该出现，更不能被选中
  const groups = useMemo(
    () => buildRecipientGroups(members, tree, org?.manageableDepartmentIds ?? []),
    [members, tree, org],
  );
  const visible = useMemo(() => filterRecipientGroups(groups, keyword), [groups, keyword]);
  const visibleIds = useMemo(
    () => visible.flatMap((group) => group.options.map((option) => option.id)),
    [visible],
  );
  const selectedOptions = useMemo(
    () => groups.flatMap((group) => group.options).filter((option) => selected.includes(option.id)),
    [groups, selected],
  );

  return (
    <Screen>
      <EditorHeader
        title="选择下发对象"
        cancelLabel="取消"
        saveLabel="确定"
        onCancel={onCancel}
        onSave={() => onConfirm(selected)}
        saveDisabled={selected.length === 0}
      />

      {/* 顶部常驻已选列表：选了几十个人之后，用户需要一个地方确认「我选了谁」并随时删掉选错的 */}
      <View style={[styles.selectedBar, { borderBottomColor: theme.color.border }]}>
        <Text style={{ color: theme.color.textSecondary, fontSize: 13 }}>
          已选 {selected.length} 人
        </Text>
        {selected.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="清空已选"
            onPress={() => setSelected([])}
            hitSlop={8}
          >
            <Text style={{ color: theme.color.accent, fontSize: 13 }}>清空</Text>
          </Pressable>
        ) : null}
      </View>
      {selectedOptions.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.chipRow, { borderBottomColor: theme.color.border }]}
          contentContainerStyle={{ gap: 8, paddingHorizontal: 16, alignItems: 'center' }}
        >
          {selectedOptions.map((option) => (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityLabel={`已选-${option.name}`}
              onPress={() => setSelected((current) => toggleId(current, option.id))}
              style={[
                styles.chip,
                { borderColor: theme.color.border, backgroundColor: theme.color.surfaceRaised },
              ]}
            >
              <Text style={{ color: theme.color.textPrimary, fontSize: 13 }}>{option.name}</Text>
              <Text style={{ color: theme.color.textTertiary, fontSize: 13 }}>×</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      <View style={[styles.searchRow, { paddingTop: 10 }]}>
        <View
          style={[
            styles.searchField,
            {
              backgroundColor: theme.color.surfaceRaised,
              borderColor: theme.color.border,
              borderRadius: theme.radius.card,
            },
          ]}
        >
          <TextInput
            value={keyword}
            onChangeText={setKeyword}
            placeholder="搜索姓名 / 工号 / 部门"
            placeholderTextColor={theme.color.textTertiary}
            accessibilityLabel="搜索下发对象"
            style={{ color: theme.color.textPrimary, flex: 1, fontSize: 15, padding: 0 }}
          />
          {keyword ? (
            <Pressable accessibilityLabel="清空搜索" onPress={() => setKeyword('')} hitSlop={10}>
              <Text style={{ color: theme.color.textTertiary, fontSize: 14 }}>✕</Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="全选当前结果"
          onPress={() => setSelected((current) => addIds(current, visibleIds))}
          hitSlop={6}
        >
          <Text style={{ color: theme.color.accent, fontSize: 15 }}>全选</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + theme.spacing.xl }}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <Text style={[styles.hint, { color: theme.color.textSecondary }]}>
            正在加载可下发的人员…
          </Text>
        ) : error ? (
          <Text style={[styles.hint, { color: theme.color.danger }]}>{error}</Text>
        ) : visible.length === 0 ? (
          <EmptyState
            title={keyword ? '没有匹配的人' : '没有可下发的人'}
            hint={
              keyword
                ? '换个关键词，或清空搜索看全部'
                : '你在当前组织里可下发的范围是空的（既不是组织管理员，也没有负责的部门）'
            }
          />
        ) : (
          // 页面安全边距：与其它页面一致，卡片不能贴边（spec §7.6.3）
          <View style={{ paddingHorizontal: theme.spacing.md }}>
            {visible.map((group) => {
            const allSelected = isGroupFullySelected(selected, group);
            const groupIds = group.options.map((option) => option.id);
            return (
              <View key={group.key} style={{ marginTop: theme.spacing.md }}>
                <View style={styles.groupHeader}>
                  <Text style={{ color: theme.color.textPrimary, fontSize: 15, fontWeight: '600' }}>
                    {group.title}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${allSelected ? '取消全选' : '全选'}-${group.title}`}
                    onPress={() =>
                      setSelected((current) =>
                        allSelected ? removeIds(current, groupIds) : addIds(current, groupIds),
                      )
                    }
                    hitSlop={6}
                  >
                    <Text style={{ color: theme.color.accent, fontSize: 13 }}>
                      {allSelected ? '取消全选' : `全选（${group.options.length}）`}
                    </Text>
                  </Pressable>
                </View>
                <Card>
                  {group.options.map((option) => {
                    const checked = selected.includes(option.id);
                    return (
                      <Pressable
                        key={option.id}
                        accessibilityRole="button"
                        accessibilityLabel={`成员-${option.name}`}
                        accessibilityState={{ selected: checked }}
                        onPress={() => setSelected((current) => toggleId(current, option.id))}
                        style={[styles.memberRow, { borderBottomColor: theme.color.border }]}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: theme.color.textPrimary, fontSize: 15 }}>
                            {option.name}
                          </Text>
                          <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 2 }}>
                            {option.departmentLabel} · {option.memberKey}
                          </Text>
                        </View>
                        <Text style={{ color: checked ? theme.color.accent : theme.color.textTertiary }}>
                          {checked ? '☑' : '☐'}
                        </Text>
                      </Pressable>
                    );
                  })}
                </Card>
              </View>
            );
            })}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  selectedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // 必须给横向滚动行一个**确定的高度**：只给 maxHeight 时容器会被压扁，
  // 胶囊里的名字只露出上半截（实测踩过）。46 装得下「1 行文字 + 上下内边距 + 边框」。
  chipRow: { flexGrow: 0, height: 46, borderBottomWidth: StyleSheet.hairlineWidth },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  searchField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 40,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  hint: { textAlign: 'center', marginTop: 32, fontSize: 14 },
});
