#!/usr/bin/env python3
"""上架合规门禁（应用宝《隐私政策提交内容及审核规范》）。

每个版本都要跑；CI 里跑，未通过即构建失败。

    python3 scripts/check_compliance.py

它只做**能被机器判定**的那部分：合规文本是否齐全、隐私政策是否单独成文、
App 侧是否真的有首启同意弹窗 / 非默认勾选 / 注销入口 / 隐私常驻入口、
契约与后端是否真的提供了对应端点。

需要真人点一遍的项（拒绝权限后 App 是否仍可用、注销是否真的生效、
链接是否真的不用登录）在 docs/legal/compliance-checklist.md 里标了「人工」。

新增检查项时：把它加进 CHECKS，并在 compliance-checklist.md 里同步一行说明，
否则下一个人看不出这条规则为什么存在。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEGAL = ROOT / "docs" / "legal"
STRICT = "--strict" in sys.argv

#: 提交审核前必须清掉的占位符
PLACEHOLDER = "【待替换"


class Failure(Exception):
    """一条检查未通过。message 里必须写清「怎么修」。"""


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise Failure(f"缺少文件 {path.relative_to(ROOT)}") from exc


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Failure(message)


def require_contains(haystack: str, needles: list[str], where: str, fix: str) -> None:
    missing = [needle for needle in needles if needle not in haystack]
    require(not missing, f"{where} 里找不到 {missing}；{fix}")


def strip_comments(source: str) -> str:
    """去掉注释后再做「不许出现某句话」这类检查。

    只处理块注释（包含 JSX 的 `{/* … */}`）与**整行**的 `//` 注释：
    不能无脑按 `//` 切，否则 `https://…` 会被截断。
    """
    without_block = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return "\n".join(
        "" if line.lstrip().startswith("//") else line for line in without_block.splitlines()
    )


# --------------------------------------------------------------------------------------
# A. 隐私政策提交规范
# --------------------------------------------------------------------------------------

LEGAL_DOCS = [
    "privacy-policy.md",
    "user-agreement.md",
    "children-privacy.md",
    "personal-info-collected.md",
    "shared-info-with-third-parties.md",
]


def check_legal_documents_exist() -> None:
    for name in LEGAL_DOCS + ["README.md", "compliance-checklist.md"]:
        text = read(LEGAL / name)
        require(len(text) > 400, f"docs/legal/{name} 内容过短（{len(text)} 字），疑似被清空")


def check_single_source() -> None:
    """App 不能自带一份隐私政策正文——那是漂移的根源（规范 A1 / A4）。"""
    marker = "我们如何收集和使用您的个人信息"
    offenders = []
    for path in (ROOT / "app" / "src").rglob("*"):
        if path.suffix in {".ts", ".tsx"} and marker in path.read_text(encoding="utf-8"):
            offenders.append(str(path.relative_to(ROOT)))
    require(
        not offenders,
        "以下 App 源文件内嵌了隐私政策正文，会与服务端链接漂移：" + ", ".join(offenders)
        + "；App 必须用 WebView 打开 /api/v1/legal/{doc}，不要内嵌正文",
    )


def check_policy_standalone() -> None:
    """规范 §2.1：隐私政策必须单独成文，不能作为用户协议的一部分。"""
    agreement = read(LEGAL / "user-agreement.md")
    require(
        "我们如何收集和使用您的个人信息" not in agreement,
        "user-agreement.md 里出现了隐私政策的正文章节；隐私政策必须单独成文，"
        "用户协议只能引用《时纪流隐私政策》这个文件名",
    )
    require(
        "隐私政策" in agreement,
        "user-agreement.md 里没有提到隐私政策；用户协议应明确个人信息规则记载于独立的隐私政策",
    )


def check_policy_subject() -> None:
    """规范 §2.2：必须有明确的主体公司信息。"""
    policy = read(LEGAL / "privacy-policy.md")
    require_contains(
        policy,
        ["运营主体", "注册地址"],
        "privacy-policy.md",
        "规范 §2.2 要求隐私政策里声明运营主体信息，且须与商店后台填写的运营方一致",
    )


def check_policy_structure() -> None:
    """规范 §二-1：十节结构，且要说明存储区域与保留时间。"""
    policy = read(LEGAL / "privacy-policy.md")
    require_contains(
        policy,
        [
            "一、导言",
            "二、我们如何收集和使用您的个人信息",
            "三、我们如何使用 Cookie 和同类技术",
            "四、我们如何共享、转让、公开披露您的个人信息",
            "五、我们如何保护您的个人信息",
            "六、信息的存储",
            "七、您如何管理您的个人信息",
            "八、未成年人保护",
            "九、其他",
            "十、本政策的变更",
        ],
        "privacy-policy.md",
        "按规范 §二-1 的模板补齐缺失章节",
    )
    require_contains(
        policy,
        ["存储地点", "存储期限", "中华人民共和国境内"],
        "privacy-policy.md",
        "规范 §二-1 要求在「信息的存储」里说明地理区域与保留时间",
    )


def check_policy_sensitive_marked() -> None:
    """规范 §2.3：敏感个人信息要用显著方式（加粗）标识。"""
    policy = read(LEGAL / "privacy-policy.md")
    require_contains(
        policy,
        ["**手机号码**", "**昵称**", "**粗略/精确地理位置**"],
        "privacy-policy.md",
        "收集清单里的敏感 / 关键个人信息要用 **加粗** 标识",
    )


def check_policy_deletion_steps() -> None:
    """规范 §2.7：隐私政策里要写清注销步骤流程，且承诺不超过 15 个工作日。"""
    policy = read(LEGAL / "privacy-policy.md")
    require_contains(
        policy,
        ["账号注销", "我的 → 隐私与合规 → 账号注销", "15 个工作日"],
        "privacy-policy.md",
        "规范 §2.7 要求写明注销步骤，路径必须与 App 内真实入口一致",
    )


def check_policy_no_personalized_push() -> None:
    """规范 §2.8：不做个性化推送就必须明说；做了就必须有开关。"""
    policy = read(LEGAL / "privacy-policy.md")
    require_contains(
        policy,
        ["个性化推荐", "不提供个性化推荐"],
        "privacy-policy.md",
        "若本应用仍不做个性化推送，请在「其他」一章明确声明「本应用不提供个性化推荐…」；"
        "若上线了该功能，则必须同时在 App 内提供名称显著的关闭开关",
    )


def check_children_policy() -> None:
    """规范 §2.8-3：儿童（14 周岁以下）隐私政策要单独明示。"""
    policy = read(LEGAL / "privacy-policy.md")
    children = read(LEGAL / "children-privacy.md")
    require_contains(
        policy,
        ["不满 **14 周岁**", "儿童个人信息保护声明"],
        "privacy-policy.md",
        "未成年人保护一章要单独明示儿童隐私政策并指向独立声明",
    )
    require_contains(
        children,
        ["不满十四周岁", "监护人", "15 个工作日"],
        "children-privacy.md",
        "儿童隐私声明要写清适用范围、监护人权利与响应时限",
    )


def check_info_lists() -> None:
    """规范 §2.8-4：App 二级菜单要有「已收集个人信息清单」「与第三方共享个人信息清单」。"""
    collected = read(LEGAL / "personal-info-collected.md")
    shared = read(LEGAL / "shared-info-with-third-parties.md")
    require_contains(
        collected,
        ["手机号码", "地理位置", "使用目的", "适用场景"],
        "personal-info-collected.md",
        "清单要逐项列出信息名称 / 使用目的 / 适用场景",
    )
    require_contains(
        shared,
        ["第三方名称", "使用目的", "处理方式", "隐私政策"],
        "shared-info-with-third-parties.md",
        "共享清单要逐项列出第三方名称 / 目的 / 方式 / 其隐私政策链接",
    )


VAGUE_LABELS = ["《附件》", "《详情》", "《更多》", "《说明》", "《点击这里》"]


def check_no_vague_link_labels() -> None:
    """规范 §2.6：超链接名称必须包含关键词，不能是《附件》《详情》。"""
    for name in LEGAL_DOCS:
        text = read(LEGAL / name)
        for label in VAGUE_LABELS:
            require(
                label not in text,
                f"docs/legal/{name} 里出现了无信息量的链接名 {label}；"
                "规范 §2.6 要求链接名含关键词（如《第三方SDK名称信息》《个人信息保护政策》）",
            )


def check_standard_wording() -> None:
    """规范 §三：用规范化的信息名称表述。"""
    collected = read(LEGAL / "personal-info-collected.md")
    require_contains(
        collected,
        ["手机号码", "地理位置", "设备信息", "个人上网记录"],
        "personal-info-collected.md",
        "规范 §三 要求使用「手机号码 / 地理位置 / 设备信息 / 个人上网记录」等标准表述",
    )


def check_assistant_disclosure() -> None:
    """小安接入第三方大模型后必须同步的声明（规范 §2.8-5 / §四 D4、D5、D6）。

    这一类改动最容易漏：功能上「能用了」，但清单里还写着「不申请麦克风、不与第三方共享」，
    审核按「声明与实际不符」判，一次就够打回。
    """
    policy = read(LEGAL / "privacy-policy.md")
    shared = read(LEGAL / "shared-info-with-third-parties.md")
    collected = read(LEGAL / "personal-info-collected.md")

    require_contains(
        policy,
        ["百炼", "通义千问", "麦克风（RECORD_AUDIO）", "转写完成后音频立即丢弃"],
        "privacy-policy.md",
        "接入了第三方模型服务就必须写进 §4.1 共享与 §9.1 第三方 SDK 目录，"
        "麦克风要进 §9.2 权限清单，并写明「转写完成后音频立即丢弃」",
    )
    require_contains(
        shared,
        ["百炼", "语音"],
        "shared-info-with-third-parties.md",
        "向百炼共享的内容要逐项写进《与第三方共享个人信息清单》",
    )
    require_contains(
        collected,
        ["小安的对话内容", "语音（录音）"],
        "personal-info-collected.md",
        "对话与语音是新的信息收集点，要进《已收集个人信息清单》",
    )
    require(
        "申请相机、麦克风" not in policy,
        "privacy-policy.md 还在说「不会申请相机、麦克风」——语音输入上线后这句话已经不成立了，"
        "必须改成只声明不申请相机",
    )
    permissions = read(APP_SRC / "domain" / "permissions.ts")
    require_contains(
        permissions,
        ["microphone"],
        "domain/permissions.ts",
        "麦克风也要「先说明用途再申请」（规范 §四「未及时明确告知索取权限的目的和用途」）",
    )
    system = read(
        ROOT / "backend-java" / "xa-bootstrap" / "src" / "main" / "java" / "com" / "xatodo"
        / "bootstrap" / "web" / "SystemController.java"
    )
    require_contains(
        system,
        ["aiAgentEnabled"],
        "SystemController.java",
        "App 靠 /system/info 的 aiAgentEnabled 判断小安能不能用；没有它，"
        "模型没配置时界面会假装能用（spec §11 阶段三）",
    )


# --------------------------------------------------------------------------------------
# B. 契约与后端
# --------------------------------------------------------------------------------------


def check_contract_endpoints() -> None:
    contract = json.loads(read(ROOT / "contract" / "api-contract.json"))
    index = {(item["method"], item["path"]): item for item in contract["endpoints"]}
    legal = index.get(("GET", "/api/v1/legal/{doc}"))
    deletion = index.get(("POST", "/api/v1/me/deletion"))
    require(legal is not None, "契约里缺少 GET /api/v1/legal/{doc}：隐私政策等合规文本的公开地址")
    require(legal["auth"] == "none", "GET /api/v1/legal/{doc} 必须免鉴权（商店要能直接抓取）")
    require(deletion is not None, "契约里缺少 POST /api/v1/me/deletion：账号注销接口（规范 §2.7）")
    require(deletion["auth"] == "access", "POST /api/v1/me/deletion 需要登录态，auth 应为 access")


def check_backend_implementations() -> None:
    security = read(
        ROOT / "backend-java" / "xa-bootstrap" / "src" / "main" / "java" / "com" / "xatodo"
        / "bootstrap" / "config" / "SecurityConfig.java"
    )
    require_contains(
        security,
        ["/api/v1/legal/**"],
        "SecurityConfig.java",
        "合规文本必须 permitAll，否则商店和应用内 WebView 都打不开",
    )
    java_legal = list((ROOT / "backend-java").rglob("LegalController.java"))
    py_legal = ROOT / "backend-python" / "app" / "routers" / "legal.py"
    require(java_legal, "Java 版缺少 LegalController（/api/v1/legal/**）")
    require(py_legal.exists(), "Python 版缺少 app/routers/legal.py（/api/v1/legal/**）")
    java_me = read(
        ROOT / "backend-java" / "xa-auth" / "src" / "main" / "java" / "com" / "xatodo"
        / "auth" / "web" / "MeController.java"
    )
    require_contains(java_me, ['"/deletion"'], "MeController.java", "账号注销端点 POST /me/deletion 未实现")
    py_me = read(ROOT / "backend-python" / "app" / "routers" / "me.py")
    require_contains(py_me, ["/deletion"], "me.py", "账号注销端点 POST /me/deletion 未实现")


def check_legal_pages_are_static() -> None:
    """规范 §四：链接页面要能被自动化分析，别塞脚本/跳转。"""
    for name in LEGAL_DOCS:
        text = read(LEGAL / name)
        require(
            "<script" not in text.lower(),
            f"docs/legal/{name} 里出现了 <script>；合规文本页面必须是纯静态文本，"
            "不能有脚本或跳转（规范 §一-2②）",
        )


# --------------------------------------------------------------------------------------
# C. App 侧
# --------------------------------------------------------------------------------------

APP_SRC = ROOT / "app" / "src"


def _legal_entry(slug: str) -> tuple[str, str]:
    """从 app/src/domain/legal.ts 里取某个文档的 (title, label)。

    界面里写的是 `LEGAL_DOCS['privacy-policy'].title` 这种引用，不是字面量，
    所以检查必须认这个引用——否则要么误报，要么逼着大家把标题抄两遍（那就等着漂移）。
    """
    text = read(APP_SRC / "domain" / "legal.ts")
    block = re.search(rf"'{re.escape(slug)}':\s*\{{(.*?)\}}", text, re.S)
    require(block is not None, f"domain/legal.ts 里找不到文档入口 {slug}")
    body = block.group(1)
    title = re.search(r"title:\s*'([^']*)'", body)
    label = re.search(r"label:\s*'([^']*)'", body)
    require(title is not None and label is not None, f"domain/legal.ts 的 {slug} 缺 title/label")
    return title.group(1), label.group(1)


def require_legal_entry(screen_text: str, slug: str, where: str) -> None:
    """界面要么直接写了标题/全名，要么引用了 LEGAL_DOCS['slug']——两者都算数。"""
    title, label = _legal_entry(slug)
    require(
        f"'{slug}'" in screen_text or title in screen_text or label in screen_text,
        f"{where} 里既没有 {label} 的文案，也没有引用 LEGAL_DOCS['{slug}']；"
        "合规入口不能漏（规范 §2.8-4 / §四「隐私政策常驻入口」）",
    )


def check_first_launch_gate() -> None:
    gate = APP_SRC / "screens" / "PrivacyConsentScreen.tsx"
    require(gate.exists(), "App 缺少首启隐私政策弹窗（PrivacyConsentScreen.tsx）：规范 §四 要求首次进入必须弹窗征求同意")
    text = read(gate)
    require_contains(
        text,
        ["同意", "不同意"],
        "PrivacyConsentScreen.tsx",
        "首启弹窗必须同时给出「同意」与「不同意」两个清晰选项（规范 §三-二）",
    )
    require_contains(
        text,
        ["14 周岁"],
        "PrivacyConsentScreen.tsx",
        "规范 §二-3(二) 要求首次打开 App 时向用户明示儿童隐私政策内容",
    )
    require_legal_entry(text, "children-privacy", "PrivacyConsentScreen.tsx")
    app = read(APP_SRC / "App.tsx")
    require_contains(
        app,
        ["PrivacyConsentScreen"],
        "App.tsx",
        "首启弹窗必须挂在根导航上（未同意前不能进入登录页 / 主界面）",
    )


def check_login_consent_checkbox() -> None:
    """规范 §四 D2：登录页要主动提醒且不得默认勾选。"""
    consent = APP_SRC / "domain" / "consent.ts"
    require(consent.exists(), "App 缺少 domain/consent.ts：同意状态的纯逻辑要能单测，不能只写在界面里")
    consent_text = read(consent)
    require_contains(
        consent_text,
        ["canSubmitLogin", "hasAcceptedPolicy"],
        "domain/consent.ts",
        "同意逻辑必须提供 canSubmitLogin / hasAcceptedPolicy 这类可单测的函数",
    )
    login = strip_comments(read(APP_SRC / "screens" / "LoginScreen.tsx"))
    require_contains(
        login,
        ["canSubmitLogin"],
        "LoginScreen.tsx",
        "登录页必须用 canSubmitLogin 控制提交按钮，不能只看手机号与验证码",
    )
    require_legal_entry(login, "privacy-policy", "LoginScreen.tsx")
    require_legal_entry(login, "user-agreement", "LoginScreen.tsx")
    require(
        "登录即表示同意" not in login,
        "LoginScreen.tsx 仍在用「登录即表示同意」——这正是规范 §四明确点名的违规写法（默认同意）。"
        "必须改成用户主动勾选，且默认不勾选。",
    )


def check_app_policy_entries() -> None:
    settings = read(APP_SRC / "screens" / "SettingsScreen.tsx")
    require_contains(
        settings,
        ["隐私与合规", "账号注销"],
        "SettingsScreen.tsx",
        "「我的」页必须有合规常驻入口。规范 §四 要求主界面到隐私政策入口不超过 4 步："
        "主界面 → 我的 → 隐私与合规 → 隐私政策，正好 3 步",
    )
    for slug in (
        "privacy-policy",
        "user-agreement",
        "children-privacy",
        "personal-info-collected",
        "shared-info-with-third-parties",
    ):
        require_legal_entry(settings, slug, "SettingsScreen.tsx")
    app = read(APP_SRC / "App.tsx")
    require_contains(
        app,
        ["Legal", "AccountDeletion"],
        "App.tsx",
        "合规文本页与账号注销页要注册成导航路由",
    )


def check_permission_rationale() -> None:
    """规范 §四 D6：申请权限前要告知用途，拒绝后不得强制退出。"""
    helper = APP_SRC / "domain" / "permissions.ts"
    require(
        helper.exists(),
        "App 缺少 domain/permissions.ts：申请相册 / 定位前必须说明用途（规范 §四「未及时明确告知用户"
        "索取权限的目的和用途」）",
    )
    text = read(helper)
    require_contains(
        text,
        ["photo", "camera", "location", "notification"],
        "domain/permissions.ts",
        "相册 / 相机 / 定位 / 通知四类权限都要有用途说明文案（拍照识别重新上线后，"
        "相机也要「先说明用途再申请」）",
    )
    for screen in [
        "AgendaScreen.tsx",
        "OrgEventsScreen.tsx",
        "SettingsScreen.tsx",
        "FeedbackScreen.tsx",
        "LocationPickerScreen.tsx",
    ]:
        body = read(APP_SRC / "screens" / screen)
        require(
            "PermissionsAsync" not in body or "ensurePermission" in body,
            f"{screen} 直接调了系统权限申请，没有先说明用途；"
            "统一走 domain/permissions.ts 的 ensurePermission（先解释、再申请、拒绝也不退出）",
        )
    # 适配层之外**任何**文件都不许直接申请权限：通知的排期模块是最近新增的一个，
    # 它必须走 components/permission.ts 的 askPermission，而不是自己 request
    for path in sorted(APP_SRC.rglob("*.ts*")):
        if path.name == "permission.ts" and path.parent.name == "components":
            continue
        body = read(path)
        if "PermissionsAsync" not in body:
            continue
        require(
            "askPermission" in body or "ensurePermission" in body,
            f"{path.relative_to(APP_SRC)} 直接调了系统权限申请，没有先说明用途；"
            "统一走 components/permission.ts 的 askPermission（先解释、再申请、拒绝也不退出）",
        )


CHECKS = [
    ("legal-docs-exist", "合规文本齐全", check_legal_documents_exist),
    ("legal-single-source", "App 不内嵌隐私政策正文（与链接同源）", check_single_source),
    ("policy-standalone", "隐私政策单独成文", check_policy_standalone),
    ("policy-subject-declared", "隐私政策声明运营主体", check_policy_subject),
    ("policy-ten-sections", "隐私政策十节结构 + 存储说明", check_policy_structure),
    ("policy-sensitive-marked", "敏感个人信息显著标识", check_policy_sensitive_marked),
    ("policy-deletion-steps", "隐私政策写明注销步骤与时限", check_policy_deletion_steps),
    ("policy-personalized-push", "个性化推送声明与关闭方式", check_policy_no_personalized_push),
    ("children-policy", "儿童隐私政策单独明示", check_children_policy),
    ("info-lists", "已收集 / 与第三方共享 双清单", check_info_lists),
    ("no-vague-link-label", "链接名称含关键词", check_no_vague_link_labels),
    ("standard-wording", "个人信息标准表述", check_standard_wording),
    ("assistant-disclosure", "小安（第三方模型）与麦克风的声明同步", check_assistant_disclosure),
    ("legal-pages-static", "合规页面为纯静态文本", check_legal_pages_are_static),
    ("contract-endpoints", "契约含 /legal 与 /me/deletion", check_contract_endpoints),
    ("backend-legal-endpoints", "两版后端都实现了合规端点", check_backend_implementations),
    ("first-launch-consent-gate", "首启隐私政策弹窗", check_first_launch_gate),
    ("login-consent-checkbox", "登录页非默认勾选同意", check_login_consent_checkbox),
    ("app-policy-entry", "App 内合规常驻入口 ≤ 4 步", check_app_policy_entries),
    ("permission-rationale", "权限用途说明，拒绝不退出", check_permission_rationale),
]

#: 「警告」类检查：平时只提示，加 --strict（发版前）才当失败。
#: 这类项的共同点是**仓库本身没问题，但上线前必须由人填/确认**，不该让日常 CI 常红。
WARNINGS: list[tuple[str, str, str]] = []


def check_no_placeholders() -> None:
    """正文里还留着 【待替换：…】 说明主体信息没填全。"""
    hits: list[str] = []
    for name in LEGAL_DOCS:
        for number, line in enumerate(read(LEGAL / name).splitlines(), start=1):
            if PLACEHOLDER in line:
                hits.append(f"docs/legal/{name}:{number}")
    if hits:
        WARNINGS.append(
            (
                "no-placeholders（合规文本无待填占位）",
                "以下位置还留着占位符，提交应用商店前必须替换成真实的联系方式：\n   "
                + "\n   ".join(hits)
                + "\n   清单见 docs/legal/README.md",
            )
        )


def collect_warnings() -> None:
    check_no_placeholders()


def main() -> int:
    width = max(len(name) for name, _, _ in CHECKS)
    failed: list[tuple[str, str]] = []
    for name, title, check in CHECKS:
        try:
            check()
        except Failure as failure:
            failed.append((f"{name}（{title}）", str(failure)))
            print(f"  ✗ {name.ljust(width)}  {title}")
        else:
            print(f"  ✓ {name.ljust(width)}  {title}")

    collect_warnings()

    print()
    if WARNINGS:
        for name, message in WARNINGS:
            marker = "✗" if STRICT else "!"
            print(f"{marker} {name}\n   {message}\n")
        if STRICT:
            failed.extend(WARNINGS)

    if failed:
        print(f"合规检查未通过：{len(failed)} / {len(CHECKS)} 项")
        for name, message in failed:
            print(f"\n✗ {name}\n   {message}")
        print("\n清单与说明见 docs/legal/compliance-checklist.md")
        return 1
    print(f"合规检查全部通过（{len(CHECKS)} 项）。")
    print("仍需人工确认的项见 docs/legal/compliance-checklist.md 的「人工」标记。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
