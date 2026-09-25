#!/usr/bin/env python3
"""构建一个「大型企业」组织数据集：多层级部门树 + 全量账号 + 各部门负责人。

用途：验证组织身份全链路（切换身份 / 组织日程 / 回执）与组织管理端接口，
因为数据量足够大，也能顺带暴露分页、部门范围判定与权限边界的问题。

为什么直接写库而不走 API：
    `/org-admin/members` 要求调用方已经是该组织的组织管理员（携带组织身份令牌），
    而「首位组织成员」没有任何 API 可以创建——这是一个真实的产品断点（见 README/交接文档）。
    在补上超管建成员接口之前，种子数据只能直接落库。

幂等：按「组织编码 / 部门路径 / 手机号」判重，重复执行不会产生重复数据。

用法：
    backend-python/.venv/bin/python scripts/seed_demo_org.py
    backend-python/.venv/bin/python scripts/seed_demo_org.py --org-code XATECH --head-phone 18006569106
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field

import psycopg

DB_URL = "postgresql://postgres@localhost:5432/xatodo"


@dataclass
class Node:
    """一个部门；members 是「直接挂在它下面」的人数，不含子部门。"""

    name: str
    members: int = 0
    job_titles: list[str] = field(default_factory=list)
    children: list["Node"] = field(default_factory=list)


def tree() -> list[Node]:
    """技术 / 产品 / 市场 / 职能 四个中心，三层：中心 → 部 → 组。"""
    return [
        Node("技术中心", 3, ["技术总监", "技术副总监", "技术助理"], [
            Node("基础架构部", 2, ["部门经理", "部门助理"], [
                Node("存储组", 8, ["架构师", "工程师"]),
                Node("计算组", 6, ["架构师", "工程师"]),
                Node("网络组", 5, ["工程师", "运维工程师"]),
            ]),
            Node("应用研发部", 3, ["部门经理", "部门副经理", "部门助理"], [
                Node("后端组", 14, ["后端工程师", "高级后端工程师"]),
                Node("前端组", 10, ["前端工程师", "高级前端工程师"]),
                Node("移动组", 8, ["移动端工程师"]),
            ]),
            Node("质量保障部", 2, ["部门经理", "部门助理"], [
                Node("测试一组", 7, ["测试工程师"]),
                Node("测试二组", 6, ["测试工程师"]),
            ]),
            Node("技术运营部", 2, ["部门经理", "部门助理"], [
                Node("SRE 组", 7, ["SRE 工程师"]),
                Node("安全组", 5, ["安全工程师"]),
            ]),
        ]),
        Node("产品中心", 2, ["产品总监", "产品助理"], [
            Node("产品规划部", 2, ["部门经理", "部门助理"], [
                Node("商业化组", 6, ["产品经理"]),
                Node("增长组", 5, ["产品经理", "数据分析师"]),
            ]),
            Node("设计部", 2, ["设计负责人", "部门助理"], [
                Node("交互组", 6, ["交互设计师"]),
                Node("视觉组", 5, ["视觉设计师"]),
            ]),
        ]),
        Node("市场中心", 2, ["市场总监", "市场助理"], [
            Node("品牌部", 2, ["部门经理", "部门助理"], [
                Node("内容组", 5, ["内容运营"]),
                Node("活动组", 4, ["活动运营"]),
            ]),
            Node("销售部", 3, ["销售总监", "销售副总监", "销售助理"], [
                Node("华东区", 9, ["客户经理"]),
                Node("华北区", 8, ["客户经理"]),
                Node("华南区", 7, ["客户经理"]),
            ]),
            Node("客户成功部", 2, ["部门经理", "部门助理"], [
                Node("实施组", 6, ["实施顾问"]),
                Node("支持组", 7, ["客户成功经理"]),
            ]),
        ]),
        Node("职能中心", 2, ["职能总监", "职能助理"], [
            Node("人力资源部", 2, ["HRBP 负责人", "部门助理"], [
                Node("招聘组", 4, ["招聘专员"]),
                Node("薪酬组", 3, ["薪酬专员"]),
            ]),
            Node("财务部", 2, ["财务经理", "部门助理"], [
                Node("核算组", 3, ["会计"]),
                Node("资金组", 3, ["出纳"]),
            ]),
            Node("法务合规部", 2, ["法务负责人", "部门助理"], [
                Node("合同组", 3, ["法务专员"]),
            ]),
        ]),
    ]


SURNAMES = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜"
GIVEN = [
    "伟", "芳", "娜", "秀英", "敏", "静", "丽", "强", "磊", "洋",
    "艳", "勇", "军", "杰", "娟", "涛", "明", "超", "秀兰", "霞",
    "平", "刚", "桂英", "文轩", "子墨", "一鸣", "思远", "雨桐", "梓涵", "浩然",
    "欣怡", "若曦", "宇轩", "晨曦", "嘉豪", "梦琪", "俊杰", "婉清", "泽宇", "静怡",
]


class NameGen:
    """确定性生成中文姓名，保证同一脚本多次执行产出一致。"""

    def __init__(self) -> None:
        self._i = 0
        self._used: set[str] = set()

    def next(self) -> str:
        while True:
            surname = SURNAMES[self._i % len(SURNAMES)]
            given = GIVEN[(self._i // len(SURNAMES)) % len(GIVEN)]
            name = surname + given
            self._i += 1
            if name not in self._used:
                self._used.add(name)
                return name


def next_phone(seq: int) -> str:
    """131 号段 + 序号，避开真实号段（189/180 等），11 位符合校验正则。"""
    return f"131{seq:08d}"


def ensure_org(conn: psycopg.Connection, code: str, name: str, max_members: int) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM organization WHERE code = %s", (code,))
        row = cur.fetchone()
        if row:
            cur.execute(
                "UPDATE organization SET max_members = GREATEST(max_members, %s) WHERE id = %s",
                (max_members, row[0]),
            )
            return row[0]
        cur.execute(
            "INSERT INTO organization (name, code, max_members, timezone, status)"
            " VALUES (%s, %s, %s, 'Asia/Shanghai', 'ACTIVE') RETURNING id",
            (name, code, max_members),
        )
        return cur.fetchone()[0]


def ensure_department(conn, org_id: int, parent_id: int | None, parent_path: str, name: str, sort: int) -> int:
    with conn.cursor() as cur:
        if parent_id is None:
            cur.execute(
                "SELECT id, path FROM department WHERE org_id=%s AND parent_id IS NULL AND name=%s",
                (org_id, name),
            )
        else:
            cur.execute(
                "SELECT id, path FROM department WHERE org_id=%s AND parent_id=%s AND name=%s",
                (org_id, parent_id, name),
            )
        row = cur.fetchone()
        if row:
            return row[0]
        # path 先占位再回填：物化路径需要自增 id 才能定型
        cur.execute(
            "INSERT INTO department (org_id, parent_id, name, path, level, sort_order, status)"
            " VALUES (%s, %s, %s, '/', %s, %s, 'ACTIVE') RETURNING id",
            (org_id, parent_id, name, parent_path.count("/"), sort),
        )
        dept_id = cur.fetchone()[0]
        cur.execute(
            "UPDATE department SET path = %s WHERE id = %s",
            (f"{parent_path}{dept_id}/", dept_id),
        )
        return dept_id


def ensure_member(conn, org_id: int, dept_id: int, phone: str, real_name: str, member_key: str,
                  job_title: str, org_role: str) -> int:
    """建/取账号 + 组织身份 + 成员关系，返回 org_member.id。"""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM account WHERE phone = %s", (phone,))
        row = cur.fetchone()
        if row:
            account_id = row[0]
        else:
            cur.execute("INSERT INTO account (phone, status) VALUES (%s, 'ACTIVE') RETURNING id", (phone,))
            account_id = cur.fetchone()[0]

        cur.execute(
            "SELECT id FROM identity WHERE account_id=%s AND identity_type='ORG_MEMBER' AND org_id=%s",
            (account_id, org_id),
        )
        row = cur.fetchone()
        if row:
            identity_id = row[0]
        else:
            cur.execute(
                "INSERT INTO identity (account_id, identity_type, org_id, nickname, status)"
                " VALUES (%s, 'ORG_MEMBER', %s, %s, 'ACTIVE') RETURNING id",
                (account_id, org_id, real_name),
            )
            identity_id = cur.fetchone()[0]

        cur.execute(
            "SELECT id FROM org_member WHERE org_id=%s AND identity_id=%s", (org_id, identity_id)
        )
        row = cur.fetchone()
        if row:
            return row[0]
        cur.execute(
            "INSERT INTO org_member (org_id, identity_id, department_id, member_key, real_name, org_role, job_title, status)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, 'ACTIVE') RETURNING id",
            (org_id, identity_id, dept_id, member_key, real_name, org_role, job_title),
        )
        return cur.fetchone()[0]


def grant_department_manager(conn, dept_id: int, member_id: int, admin_id: int | None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO department_manager (department_id, org_member_id, granted_by_admin_id)"
            " VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
            (dept_id, member_id, admin_id),
        )
        cur.execute("UPDATE department SET leader_member_id = %s WHERE id = %s", (member_id, dept_id))


def main() -> int:
    parser = argparse.ArgumentParser(description="构建模拟大型企业的组织数据")
    parser.add_argument("--org-code", default="XATECH")
    parser.add_argument("--org-name", default="心安科技")
    parser.add_argument("--head-phone", default="18006569106",
                        help="指定这个手机号的账号作为中间部门负责人（App 登录账号）")
    parser.add_argument("--head-department", default="应用研发部",
                        help="上面那个账号担任负责人的部门名（需是中间层级部门）")
    args = parser.parse_args()

    names = NameGen()
    phone_seq = 1
    created_departments = 0
    created_members = 0
    head_info: dict[str, str] = {}
    member_no_seq = 1

    with psycopg.connect(DB_URL) as conn:
        org_id = ensure_org(conn, args.org_code, args.org_name, 2000)
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM admin_user WHERE org_id = %s ORDER BY id LIMIT 1", (org_id,))
            row = cur.fetchone()
            admin_id = row[0] if row else None

        def walk(nodes: list[Node], parent_id: int | None, parent_path: str) -> None:
            nonlocal phone_seq, member_no_seq, created_departments, created_members
            for sort, node in enumerate(nodes, start=1):
                before = 0
                with conn.cursor() as cur:
                    cur.execute("SELECT count(*) FROM department WHERE org_id=%s AND name=%s", (org_id, node.name))
                    before = cur.fetchone()[0]
                dept_id = ensure_department(conn, org_id, parent_id, parent_path, node.name, sort)
                if before == 0:
                    created_departments += 1

                # 部门直属成员：第一个人是负责人
                dept_members: list[int] = []
                for idx in range(node.members):
                    if idx == 0 and node.name == args.head_department:
                        phone = args.head_phone
                        real_name = "王思远"
                    else:
                        phone = next_phone(phone_seq)
                        phone_seq += 1
                        real_name = names.next()
                    job_title = node.job_titles[idx % len(node.job_titles)] if node.job_titles else "成员"
                    # 一级中心负责人给组织管理员角色，便于验证组织管理端接口
                    org_role = "ADMIN" if (parent_id is None and idx == 0) else "MEMBER"
                    member_no = f"E{org_id:02d}{member_no_seq:05d}"
                    member_no_seq += 1

                    with conn.cursor() as cur:
                        cur.execute("SELECT count(*) FROM org_member WHERE org_id=%s", (org_id,))
                        members_before = cur.fetchone()[0]
                    member_id = ensure_member(
                        conn, org_id, dept_id, phone, real_name, member_no, job_title, org_role
                    )
                    with conn.cursor() as cur:
                        cur.execute("SELECT count(*) FROM org_member WHERE org_id=%s", (org_id,))
                        if cur.fetchone()[0] > members_before:
                            created_members += 1
                    dept_members.append(member_id)

                    if idx == 0:
                        grant_department_manager(conn, dept_id, member_id, admin_id)
                        if node.name == args.head_department:
                            head_info.update({
                                "phone": phone,
                                "name": real_name,
                                "title": job_title,
                                "department": node.name,
                            })

                walk(node.children, dept_id, f"{parent_path}{dept_id}/")

        walk(tree(), None, "/")

        # 组织拥有者：单独放一个「总裁办」，保证 OWNER 唯一且在组织内
        root = ensure_department(conn, org_id, None, "/", "总裁办", 99)
        owner_member = ensure_member(
            conn, org_id, root, next_phone(phone_seq), "陆承宇",
            f"E{org_id:02d}{member_no_seq:05d}", "首席执行官", "OWNER",
        )
        grant_department_manager(conn, root, owner_member, admin_id)

        conn.commit()

        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM department WHERE org_id=%s", (org_id,))
            dept_total = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM org_member WHERE org_id=%s", (org_id,))
            member_total = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM department_manager dm JOIN department d ON d.id=dm.department_id WHERE d.org_id=%s", (org_id,))
            manager_total = cur.fetchone()[0]

    print("组织模拟数据就绪")
    print(f"  组织            : #{org_id} {args.org_name} ({args.org_code})")
    print(f"  部门总数        : {dept_total}（本次新建 {created_departments}）")
    print(f"  成员总数        : {member_total}（本次新建 {created_members}）")
    print(f"  部门负责人数    : {manager_total}")
    if head_info:
        print("  中间部门负责人  : {name}（{phone}） · {department} · {title}".format(**head_info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
