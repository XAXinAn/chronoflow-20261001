#!/usr/bin/env python3
"""构建两个「完整架构」的组织数据集：一家互联网企业 + 一所高校。

和上一版 `scripts/seed_demo_org.py` 的区别：**全部走正式接口**（组织管理端 API），
不再直接写库。当初之所以直连数据库，是因为「新组织没有入口创建首位成员」——
那条断点在第三轮已经打通（spec §4.3：后台组织管理员的令牌也能调 `/org-admin/**`）。
种子脚本也走 API，等于顺手把那条链路一直保持在可用状态：它一旦断，脚本先炸。

幂等：组织按编码、部门按父级+名称、成员按唯一识别 ID 判重，重复执行不产生重复数据。

用法：
    backend-python/.venv/bin/python scripts/seed_demo_orgs.py            # 两个组织都建
    backend-python/.venv/bin/python scripts/seed_demo_orgs.py --only LEODIGITAL
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field

BASE_URL = "http://localhost:8080/api/v1"
SUPER_ADMIN = ("admin", "admin123456")

# 组织拥有者：先前的脚本已经把这个手机号认领成两个组织的成员，这里只做校验不重复建
OWNER_MEMBER_KEY = "18006569106"


@dataclass
class Node:
    """一个部门。`members` 是直接挂在它下面的人数（不含子部门），第一个人自动成为负责人。"""

    name: str
    titles: list[str] = field(default_factory=list)
    children: list["Node"] = field(default_factory=list)

    @property
    def headcount(self) -> int:
        return len(self.titles)


def leo_tree() -> list[Node]:
    """利欧数字：中心 → 部 → 组，三层，典型互联网/数字营销企业。"""
    return [
        Node("技术中心", ["技术总监", "技术助理"], [
            Node("前端部", ["前端负责人"], [
                Node("Web 组", ["前端组长", "高级前端工程师", "前端工程师", "前端工程师", "前端工程师"]),
                Node("客户端组", ["客户端组长", "iOS 工程师", "Android 工程师"]),
            ]),
            Node("后端部", ["后端负责人"], [
                Node("服务端组", ["服务端组长", "高级后端工程师", "后端工程师", "后端工程师", "后端工程师"]),
                Node("数据平台组", ["数据平台组长", "数据工程师", "数据工程师"]),
            ]),
            Node("质量部", ["质量负责人"], [
                Node("测试组", ["测试组长", "测试工程师", "测试工程师", "测试开发工程师"]),
            ]),
            Node("运维部", ["运维负责人"], [
                Node("SRE 组", ["SRE 组长", "SRE 工程师", "SRE 工程师"]),
                Node("安全组", ["安全组长", "安全工程师"]),
            ]),
        ]),
        Node("产品中心", ["产品总监", "产品助理"], [
            Node("产品部", ["产品负责人"], [
                Node("产品一组", ["产品组长", "产品经理", "产品经理"]),
                Node("产品二组", ["产品组长", "产品经理", "产品经理"]),
            ]),
            Node("设计部", ["设计负责人"], [
                Node("交互组", ["交互组长", "交互设计师", "交互设计师"]),
                Node("视觉组", ["视觉组长", "视觉设计师", "视觉设计师"]),
            ]),
            Node("用户研究部", ["用户研究负责人", "用户研究员", "用户研究员"]),
        ]),
        Node("数据与算法中心", ["数据总监", "数据分析师"], [
            Node("数据分析部", ["数据分析负责人", "数据分析师", "数据分析师", "商业分析师"]),
            Node("算法部", ["算法负责人"], [
                Node("推荐算法组", ["算法组长", "算法工程师", "算法工程师"]),
                Node("广告算法组", ["算法组长", "算法工程师", "算法工程师"]),
            ]),
        ]),
        Node("市场中心", ["市场总监", "市场助理"], [
            Node("品牌部", ["品牌负责人", "品牌经理", "品牌专员"]),
            Node("投放部", ["投放负责人"], [
                Node("效果投放组", ["投放组长", "优化师", "优化师", "优化师"]),
                Node("信息流组", ["投放组长", "优化师", "优化师"]),
            ]),
            Node("内容部", ["内容负责人"], [
                Node("内容策划组", ["内容组长", "内容策划", "内容策划"]),
                Node("短视频组", ["短视频组长", "编导", "剪辑师", "运营专员"]),
            ]),
        ]),
        Node("运营中心", ["运营总监", "运营助理"], [
            Node("用户运营部", ["用户运营负责人", "用户运营", "用户运营", "社群运营"]),
            Node("活动运营部", ["活动运营负责人", "活动运营", "活动运营"]),
        ]),
        Node("销售中心", ["销售总监", "销售助理"], [
            Node("大客户部", ["大客户负责人", "大客户经理", "大客户经理", "售前顾问"]),
            Node("中小客户部", ["中小客户负责人", "客户经理", "客户经理", "客户经理"]),
        ]),
        Node("职能中心", ["职能总监", "行政专员"], [
            Node("人力资源部", ["HRBP 负责人", "招聘专员", "薪酬绩效专员", "员工关系专员"]),
            Node("财务部", ["财务经理", "会计", "出纳"]),
            Node("法务部", ["法务负责人", "法务专员"]),
            Node("行政部", ["行政负责人", "行政专员", "前台"]),
        ]),
    ]


def zjou_tree() -> list[Node]:
    """浙江海洋大学：学院/职能部门 → 系（教研室），带教师与学生两类成员。"""

    def college(name: str, departments: list[Node]) -> Node:
        return Node(name, ["院长", "党委书记", "院办秘书"], departments)

    def department(name: str, teachers: int = 2, students: int = 4) -> Node:
        titles = ["系主任", "教授"][:teachers] if teachers <= 2 else ["系主任", "教授", "副教授"][:teachers]
        titles = titles + ["讲师"] * max(0, teachers - len(titles))
        titles = titles + ["本科生"] * students
        return Node(name, titles)

    return [
        college("海洋科学与技术学院", [
            department("物理海洋系"),
            department("海洋化学系"),
            department("海洋生物系"),
            department("海洋技术系"),
        ]),
        college("水产学院", [
            department("水产养殖系", teachers=3, students=5),
            department("渔业资源系"),
            department("海洋渔业科学与技术系"),
        ]),
        college("船舶与海运学院", [
            department("船舶工程系", teachers=3, students=5),
            department("航海技术系"),
            department("轮机工程系"),
        ]),
        college("海洋工程装备学院", [
            department("机械工程系"),
            department("电气工程系"),
            department("自动化系"),
        ]),
        college("信息工程学院", [
            department("计算机科学系", teachers=3, students=6),
            department("软件工程系", teachers=3, students=6),
            department("电子信息工程系"),
            department("网络工程系"),
        ]),
        college("经济与管理学院", [
            department("工商管理系", teachers=3, students=5),
            department("会计学系"),
            department("国际经济与贸易系"),
            department("旅游管理系"),
        ]),
        college("外国语学院", [
            department("英语系"),
            department("日语系"),
            department("商务英语系"),
        ]),
        college("食品与药学学院", [
            department("食品科学与工程系"),
            department("药学系"),
            department("海洋药物系"),
        ]),
        college("石化与能源工程学院", [
            department("化学工程系"),
            department("能源与动力工程系"),
        ]),
        college("马克思主义学院", [
            department("马克思主义基本原理教研室", teachers=3, students=0),
            department("中国近现代史纲要教研室", teachers=2, students=0),
        ]),
        Node("体育与军训部", ["部主任", "副主任", "公共体育教研室主任"], [
            department("公共体育教研室", teachers=3, students=0),
        ]),
        # 职能部门：没有下级，直接挂人
        Node("党政办公室", ["主任", "副主任", "科员", "科员"]),
        Node("教务处", ["处长", "副处长", "教务科员", "教务科员", "教务科员"]),
        Node("学生工作部", ["部长", "副部长", "辅导员", "辅导员", "心理健康教师"]),
        Node("人事处", ["处长", "副处长", "人事科员", "人事科员"]),
        Node("科学技术处", ["处长", "项目管理科员", "成果转化科员"]),
        Node("财务处", ["处长", "会计", "出纳", "预算科员"]),
        Node("图书馆", ["馆长", "采编馆员", "流通馆员", "信息咨询馆员"]),
        Node("后勤服务处", ["处长", "膳食科员", "物业科员", "维修科员"]),
    ]


ORGS = [
    {
        "code": "LEODIGITAL",
        "name": "利欧数字",
        "admin": ("leodigital_admin", "leodigital123"),
        "tree": leo_tree,
        "key_prefix": "LEO",
        "key_digits": 5,
    },
    {
        "code": "ZJOU",
        "name": "浙江海洋大学",
        "admin": ("zjou_admin", "zjou123456"),
        "tree": zjou_tree,
        "key_prefix": "T",
        "key_digits": 5,
    },
]

SURNAMES = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章"
GIVEN = [
    "伟", "芳", "娜", "敏", "静", "丽", "强", "磊", "洋", "艳", "勇", "军", "杰", "娟", "涛",
    "明", "超", "霞", "平", "刚", "文轩", "子墨", "一鸣", "思远", "雨桐", "梓涵", "浩然",
    "欣怡", "若曦", "宇轩", "晨曦", "嘉豪", "梦琪", "俊杰", "婉清", "泽宇", "静怡", "书瑶",
    "海宁", "瑞霖", "亦辰", "知微", "书涵", "宁远", "清扬", "乐言", "嘉言",
]


class NameGen:
    """确定性生成中文姓名：同一脚本多次执行产出一致，便于判重与复现。

    姓与名要走两个**互质地**的步长，否则前 52 个人会全叫「赵伟、钱伟、孙伟……」——
    这正是第一版生成器的问题，肉眼一看就知道是假数据。
    """

    def __init__(self) -> None:
        self._index = 0

    def next(self) -> str:
        surname = SURNAMES[self._index % len(SURNAMES)]
        given = GIVEN[(self._index * 13) % len(GIVEN)]
        self._index += 1
        return surname + given


def call(method: str, path: str, token: str | None = None, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(BASE_URL + path, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        return json.loads(error.read().decode())


def ok(label: str, response: dict) -> dict:
    if response.get("code") != 0:
        raise SystemExit(f"{label} 失败: {response}")
    return response["data"] if "data" in response else response


def ensure_organization(super_token: str, org: dict) -> int:
    existing = [item for item in ok("组织列表", call("GET", "/admin/organizations", super_token))
                if item["code"] == org["code"]]
    if existing:
        print(f"组织已存在：{org['name']}（id={existing[0]['id']}）")
        return existing[0]["id"]
    created = ok("建组织", call("POST", "/admin/organizations", super_token, {
        "name": org["name"], "code": org["code"],
        "adminUsername": org["admin"][0], "adminPassword": org["admin"][1]}))
    print(f"组织已建：{org['name']}（id={created['id']}，管理员={org['admin'][0]}）")
    return created["id"]


def flatten(nodes: list[Node], root_path: str) -> list[tuple[Node, str, int]]:
    """深度优先展开成 (节点, 父路径, 层级)。

    顶层节点（中心 / 学院 / 职能部门）挂在组织的「总部」下面，不是与它平级——
    否则组织树会长成一片平铺的根部门，层级语义就没了。
    """
    result: list[tuple[Node, str, int]] = []

    def walk(children: list[Node], path: str, level: int) -> None:
        for node in children:
            result.append((node, path, level))
            walk(node.children, f"{path}/{node.name}", level + 1)

    walk(nodes, root_path, 1)
    return result


def ensure_tree(admin_token: str, nodes: list[Node], root_name: str = "总部") -> dict[str, int]:
    """逐层确保部门存在，返回「部门路径 → 部门 id」。"""
    def existing_paths() -> dict[str, int]:
        tree = ok("部门树", call("GET", "/org-admin/departments", admin_token))
        mapping: dict[str, int] = {}

        def walk(items: list[dict], prefix: str) -> None:
            for item in items:
                full = f"{prefix}/{item['name']}" if prefix else item["name"]
                mapping[full] = item["id"]
                walk(item.get("children") or [], full)

        walk(tree, "")
        return mapping

    mapping = existing_paths()
    if root_name not in mapping:
        raise SystemExit(f"找不到根部门「{root_name}」，请先在组织里建它")
    created = 0
    for node, parent_path, _level in flatten(nodes, root_name):
        full = f"{parent_path}/{node.name}" if parent_path else node.name
        if full in mapping:
            continue
        parent_id = mapping[parent_path] if parent_path else None
        payload = {"name": node.name}
        if parent_id is not None:
            payload["parentId"] = parent_id
        created_dept = ok(f"建部门 {full}", call("POST", "/org-admin/departments", admin_token, payload))
        mapping[full] = created_dept["id"]
        created += 1
    print(f"  部门：已有 {len(mapping) - created} 个，新建 {created} 个，合计 {len(mapping)} 个")
    return mapping


def ensure_members(admin_token: str, org: dict, departments: dict[str, int],
                   names: NameGen) -> tuple[int, list[tuple[str, int]]]:
    """按架构补齐成员。返回 (新建人数, [(负责人编号, 部门id)])。"""
    existing = {item["memberKey"]: item for item in ok("成员列表", call("GET", "/org-admin/members", admin_token))}
    created = 0
    heads: list[tuple[str, int]] = []
    seq = 1
    student_seq = 1
    department_seq = 0

    for node, parent_path, _level in flatten(org["tree"](), "总部"):
        full = f"{parent_path}/{node.name}" if parent_path else node.name
        if full not in departments:
            continue
        dept_id = departments[full]
        for index, title in enumerate(node.titles):
            is_student = title in ("本科生", "研究生")
            if is_student:
                # 学号：4 位入学年份 + 6 位专业码 + 3 位序号，正好 13 位
                major = f"21{department_seq:04d}"
                member_key = f"2023{major}{student_seq:03d}"
                student_seq += 1
            else:
                member_key = f"{org['key_prefix']}{seq:0{org['key_digits']}d}"
                seq += 1
            if index == 0:
                heads.append((member_key, dept_id))
            if member_key in existing:
                continue
            ok(f"建成员 {node.name}/{title}",
               call("POST", "/org-admin/members", admin_token, {
                   "memberKey": member_key,
                   "realName": names.next(),
                   "departmentId": dept_id,
                   "jobTitle": title,
               }))
            created += 1
        department_seq += 1
    print(f"  成员：已有 {len(existing)} 人，新建 {created} 人，合计 {len(existing) + created} 人")
    return created, heads


def ensure_managers(admin_token: str, heads: list[tuple[str, int]]) -> int:
    """把每个部门的第一位成员设成部门负责人（部门管理员的权限范围 = 本部门 + 所有下级）。"""
    members = {item["memberKey"]: item for item in ok("成员列表", call("GET", "/org-admin/members", admin_token))}
    granted = 0
    for member_key, dept_id in heads:
        member = members.get(member_key)
        if member is None or member.get("departmentManager"):
            continue
        ok("设部门负责人", call("POST", f"/org-admin/departments/{dept_id}/managers", admin_token,
                              {"orgMemberId": member["id"]}))
        granted += 1
    print(f"  部门负责人：本次授予 {granted} 个")
    return granted


def main() -> int:
    parser = argparse.ArgumentParser(description="构建互联网企业 + 高校两个完整组织架构")
    parser.add_argument("--only", help="只处理某个组织编码，例如 LEODIGITAL")
    args = parser.parse_args()

    super_token = ok("超管登录", call("POST", "/admin/auth/login", body={
        "username": SUPER_ADMIN[0], "password": SUPER_ADMIN[1]}))["accessToken"]

    targets = [org for org in ORGS if not args.only or org["code"] == args.only]
    if not targets:
        raise SystemExit(f"没有匹配的组织编码：{args.only}")

    names = NameGen()
    for org in targets:
        org_id = ensure_organization(super_token, org)
        admin_token = ok(f"登录 {org['admin'][0]}", call("POST", "/admin/auth/login", body={
            "username": org["admin"][0], "password": org["admin"][1]}))["accessToken"]
        print(f"处理 {org['name']}（id={org_id}）：")
        departments = ensure_tree(admin_token, org["tree"]())
        _created, heads = ensure_members(admin_token, org, departments, names)
        ensure_managers(admin_token, heads)

        settings = ok("组织设置", call("GET", "/org-admin/settings", admin_token))
        members_total = len(ok("成员列表", call("GET", "/org-admin/members", admin_token)))
        dept_total = len(departments)
        # 成员数会超过组织上限时由超管上调（组织侧自己不能调，spec §4.3 / §4.4）
        if members_total > (settings.get("maxMembers") or 0):
            ok("上调成员上限", call("PATCH", f"/admin/organizations/{org_id}", super_token,
                                  {"maxMembers": 2000}))
            settings = ok("组织设置", call("GET", "/org-admin/settings", admin_token))
        print(f"  → {settings['name']}（{settings['code']}）：{dept_total} 个部门 / "
              f"{members_total} 名成员（组织上限 {settings['maxMembers']}）")

    print("完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
