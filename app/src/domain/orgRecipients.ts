import type { OrgDepartmentNode, OrgMemberItem } from '../api/types';

/**
 * 选人页的纯逻辑（spec §4.2.2「下发对象 = 选人」）。
 *
 * 组织一大（比如学校里 260 人）就会暴露两个问题：平铺列表找不到人、逐个点太慢。
 * 所以这里提供三件事：**按二级单位分组**、**搜索**、**整组勾选**。
 */

export interface RecipientOption {
  id: number;
  name: string;
  memberKey: string;
  /** 行里的部门路径（相对二级单位），例如「前端部/Web 组」 */
  departmentLabel: string;
}

export interface RecipientGroup {
  /** 二级单位（学院 / 中心）的 id；没挂在任何二级单位下时为 0 */
  key: number;
  title: string;
  options: RecipientOption[];
}

interface DepartmentIndex {
  /** 部门 id → 从根开始的名称路径 */
  pathById: Map<number, string[]>;
  /** 部门 id → 它所属的二级单位（学院 / 中心）；根与未挂接的部门为 null */
  unitById: Map<number, { id: number; name: string } | null>;
}

function indexDepartments(tree: OrgDepartmentNode[]): DepartmentIndex {
  const pathById = new Map<number, string[]>();
  const unitById = new Map<number, { id: number; name: string } | null>();

  const walk = (
    nodes: OrgDepartmentNode[],
    prefix: string[],
    unit: { id: number; name: string } | null,
    level: number,
  ) => {
    for (const node of nodes) {
      const path = [...prefix, node.name];
      pathById.set(node.id, path);
      // 第 1 层是组织根（总部），第 2 层才是「二级单位」——分组就按它来
      const thisUnit = level === 2 ? { id: node.id, name: node.name } : unit;
      unitById.set(node.id, thisUnit);
      walk(node.children ?? [], path, thisUnit, level + 1);
    }
  };

  walk(tree, [], null, 1);
  return { pathById, unitById };
}

/**
 * 按二级单位分组：`总部` 是组织根，跳过它；它下面那一层（学院 / 中心）才是分组标题。
 *
 * 分组标题用二级单位而不是最底层部门：学校有 50 多个系，按系分组等于没分组；
 * 行里保留「系 / 组」这一层，找人的信息量才够。
 *
 * `manageableDepartmentIds` 是**能不能下发给这个人**的判据，与服务端同一条规则
 * （下发时服务端会逐个校验目标成员的部门是否在调用者的可管理范围内）。
 * 必须在选择阶段就按它过滤：`GET /org/members` 对普通成员会返回他自己，
 * 不过滤的话他能选到自己，然后点下发必然 403——那就是「能选但发不出去」。
 */
export function buildRecipientGroups(
  members: OrgMemberItem[],
  tree: OrgDepartmentNode[],
  manageableDepartmentIds: number[],
): RecipientGroup[] {
  const { pathById, unitById } = indexDepartments(tree);
  const groups = new Map<number, RecipientGroup>();
  const manageable = new Set(manageableDepartmentIds);

  for (const member of members) {
    if (!manageable.has(member.departmentId)) {
      continue;
    }
    const path = pathById.get(member.departmentId) ?? [];
    const unit = unitById.get(member.departmentId) ?? null;
    const key = unit?.id ?? 0;
    const title = unit?.name ?? member.departmentName ?? '未分配部门';
    const unitDepth = unit ? (pathById.get(unit.id)?.length ?? 0) : 0;
    const rest = path.slice(unitDepth);
    const departmentLabel = rest.length > 0 ? rest.join('/') : title;

    const group = groups.get(key) ?? { key, title, options: [] };
    group.options.push({
      id: member.id,
      name: member.realName,
      memberKey: member.memberKey,
      departmentLabel,
    });
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      options: [...group.options].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    }))
    .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
}

/**
 * 搜索：命中姓名、成员唯一识别 ID、部门路径任意一项即可。
 * 空白关键词返回原样，方便调用方直接渲染。
 */
export function filterRecipientGroups(
  groups: RecipientGroup[],
  keyword: string,
): RecipientGroup[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) {
    return groups;
  }
  return groups
    .map((group) => ({
      ...group,
      options: group.options.filter(
        (option) =>
          option.name.toLowerCase().includes(needle) ||
          option.memberKey.toLowerCase().includes(needle) ||
          option.departmentLabel.toLowerCase().includes(needle) ||
          group.title.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.options.length > 0);
}

/** 勾选 / 取消某个人。 */
export function toggleId(ids: number[], id: number): number[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

/** 批量加入（整组全选、全选搜索结果都用它）。 */
export function addIds(ids: number[], additions: number[]): number[] {
  const merged = new Set(ids);
  additions.forEach((id) => merged.add(id));
  return [...merged];
}

/** 批量移除（整组取消全选）。 */
export function removeIds(ids: number[], removals: number[]): number[] {
  const removed = new Set(removals);
  return ids.filter((id) => !removed.has(id));
}

/** 某一组是否已经全选：决定按钮显示「全选」还是「取消全选」。 */
export function isGroupFullySelected(ids: number[], group: RecipientGroup): boolean {
  return group.options.length > 0 && group.options.every((option) => ids.includes(option.id));
}

/** 已选人数的展示文案；一个都没选时给引导语而不是「已选 0 人」。 */
export function selectedSummary(ids: number[]): string {
  return ids.length > 0 ? `已选 ${ids.length} 人` : '选择人员';
}
