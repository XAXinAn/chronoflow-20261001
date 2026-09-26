import { describe, expect, it } from 'vitest';

import type { OrgDepartmentNode, OrgMemberItem } from '../src/api/types';
import {
  addIds,
  buildRecipientGroups,
  filterRecipientGroups,
  isGroupFullySelected,
  removeIds,
  selectedSummary,
  toggleId,
} from '../src/domain/orgRecipients';

/** 一棵小组织树：总部 → 技术中心 → 前端部 → Web 组；另有一个市场中心。 */
const tree: OrgDepartmentNode[] = [
  {
    id: 1,
    name: '总部',
    level: 1,
    path: '/1/',
    children: [
      {
        id: 2,
        name: '技术中心',
        level: 2,
        path: '/1/2/',
        children: [
          {
            id: 3,
            name: '前端部',
            level: 3,
            path: '/1/2/3/',
            children: [{ id: 4, name: 'Web 组', level: 4, path: '/1/2/3/4/', children: [] }],
          },
        ],
      },
      { id: 5, name: '市场中心', level: 2, path: '/1/5/', children: [] },
    ],
  },
];

function member(id: number, name: string, departmentId: number, key = `E${id}`): OrgMemberItem {
  return {
    id,
    bound: false,
    departmentId,
    departmentName: '',
    realName: name,
    memberKey: key,
    orgRole: 'MEMBER',
    status: 'ACTIVE',
    departmentManager: false,
  };
}

const members = [
  member(11, '赵伟', 4, 'LEO00004'),
  member(12, '钱娟', 3),
  member(13, '孙浩然', 5),
];

describe('下发对象选人页', () => {
  /** 组织管理员：可管理全部部门（含总部、二级单位、下面的系/组） */
  const ALL_DEPARTMENTS = [1, 2, 3, 4, 5];

  it('没有下发权限的人不出现在列表里（普通成员连自己都选不了）', () => {
    // 普通成员：manageableDepartmentIds 为空 → 一个人都列不出来
    expect(buildRecipientGroups(members, tree, [])).toEqual([]);
    // 部门管理员只管「市场中心」：只列出市场中心的人，技术中心的人一个都不出现
    const groups = buildRecipientGroups(members, tree, [5]);
    expect(groups.map((group) => group.title)).toEqual(['市场中心']);
    expect(groups[0].options.map((option) => option.name)).toEqual(['孙浩然']);
  });

  it('按二级单位分组（总部不作为分组），行里带完整部门路径', () => {
    const groups = buildRecipientGroups(members, tree, ALL_DEPARTMENTS);
    // 分组按名称排序（中文按拼音：技术中心 < 市场中心）
    expect(groups.map((group) => group.title)).toEqual(['技术中心', '市场中心']);
    const tech = groups.find((group) => group.title === '技术中心');
    // 组内按姓名排序，断言按 id 取，免得依赖排序细节
    expect(tech?.options.find((option) => option.id === 11)).toEqual({
      id: 11,
      name: '赵伟',
      memberKey: 'LEO00004',
      departmentLabel: '前端部/Web 组',
    });
    expect(tech?.options.find((option) => option.id === 12)?.departmentLabel).toBe('前端部');
  });

  it('搜索命中姓名、工号、部门任意一项', () => {
    const groups = buildRecipientGroups(members, tree, ALL_DEPARTMENTS);
    expect(filterRecipientGroups(groups, '钱')[0].options.map((o) => o.name)).toEqual(['钱娟']);
    expect(filterRecipientGroups(groups, 'LEO00004')[0].options.map((o) => o.name)).toEqual(['赵伟']);
    expect(
      filterRecipientGroups(groups, '前端部')
        .flatMap((group) => group.options.map((o) => o.name))
        .sort(),
    ).toEqual(['赵伟', '钱娟']);
    // 命中单位名时整组留下
    expect(filterRecipientGroups(groups, '市场中心').map((group) => group.title)).toEqual(['市场中心']);
    expect(filterRecipientGroups(groups, '   ')).toEqual(groups);
  });

  it('勾选 / 取消 / 整组全选 / 整组取消', () => {
    expect(toggleId([1], 2)).toEqual([1, 2]);
    expect(toggleId([1, 2], 1)).toEqual([2]);
    expect(addIds([1], [1, 2, 3])).toEqual([1, 2, 3]);
    expect(removeIds([1, 2, 3], [2, 3])).toEqual([1]);
  });

  it('整组是否已全选决定按钮显示「全选」还是「取消全选」', () => {
    const tech = buildRecipientGroups(members, tree, ALL_DEPARTMENTS)
      .find((group) => group.title === '技术中心');
    expect(tech).toBeTruthy();
    expect(isGroupFullySelected([11], tech!)).toBe(false);
    expect(isGroupFullySelected([11, 12], tech!)).toBe(true);
    expect(isGroupFullySelected([11, 12, 13], tech!)).toBe(true);
  });

  it('已选摘要：没选时给引导语，不显示「已选 0 人」', () => {
    expect(selectedSummary([])).toBe('选择人员');
    expect(selectedSummary([1, 2])).toBe('已选 2 人');
  });
});
