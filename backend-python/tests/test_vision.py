"""拍照识别日程的解析与容错（spec §4.1.9）。

不依赖真实模型：模型不是被测对象，我们这一侧才是——提示词有没有把
「一图多事项」「全天跨天用次日 00:00」「看不清时间不要猜」交代清楚、
回复里的代码块/夹带文字/尾逗号能不能吃下来、未配置时会不会老实报错。
"""

from __future__ import annotations

import pytest

# 注意：**不要**在模块导入期 import app.services.vision —— 它会在 conftest 设置
# DATABASE_URL 之前就把 app.config 读进内存，于是整套用例跑去连开发库（踩过）。
# 统一在用例内部导入。

# 用户给的真实测试图（学院「中秋放假 + 离返校登记」通知）对应的模型回复：
# 一图三类事 —— 假期是全天跨天日程，登记与统计是带/不带截止的待办。
CAMPUS_NOTICE_REPLY = """
{"events":[
  {"title":"中秋节假期","kind":"EVENT","startAt":"2026-09-25T00:00:00+08:00",
   "endAt":"2026-09-28T00:00:00+08:00","allDay":true,
   "description":"放假 3 天（9 月 25 日—9 月 27 日）","confidence":0.95},
  {"title":"中秋节假期离返校登记","kind":"TASK","dueAt":"2026-09-24T23:59:00+08:00",
   "description":"钉钉→学工系统→节假日离返校→学生组；“离校不返家”需上传家长知情同意书"},
  {"title":"填写 2026-2027 秋学期中秋节返校情况","kind":"TASK",
   "description":"金山文档 https://www.kdocs.cn/l/cpk2A3hrWyCd"}
]}
"""


def test_parses_campus_notice_into_three_items() -> None:
    from app.services import vision

    items = vision._parse_items(CAMPUS_NOTICE_REPLY, "Asia/Shanghai")

    assert len(items) == 3

    holiday = items[0]
    assert holiday.kind == "EVENT"
    assert holiday.all_day is True
    # 全天跨天用 iCalendar 约定：结束时间落在最后一天的次日 00:00
    assert holiday.start_at.isoformat() == "2026-09-25T00:00:00+08:00"
    assert holiday.end_at.isoformat() == "2026-09-28T00:00:00+08:00"

    sign_up = items[1]
    assert sign_up.kind == "TASK"
    assert sign_up.due_at.isoformat() == "2026-09-24T23:59:00+08:00"
    assert "家长知情同意书" in (sign_up.description or "")

    survey = items[2]
    assert survey.kind == "TASK"
    assert survey.due_at is None
    assert "http" not in survey.title
    assert "kdocs.cn" in (survey.description or "")


def test_tolerates_code_fence_prose_and_trailing_comma() -> None:
    from app.services import vision

    messy = """
    好的，识别结果如下：
    ```json
    {'events': [
      {'title': '季度技术评审会', 'startAt': '2026-09-26 15:00',},
    ],}
    ```
    需要我帮你创建吗？
    """
    items = vision._parse_items(messy, "Asia/Shanghai")

    assert len(items) == 1
    # 「2026-09-26 15:00」没有偏移量：按请求时区补上
    assert items[0].start_at.isoformat() == "2026-09-26T15:00:00+08:00"


def test_unconfigured_model_reports_unavailable() -> None:
    from app.errors import ApiError
    from app.errors import ErrorCode
    from app.services import vision

    assert vision.configured() is False
    with pytest.raises(ApiError) as failure:
        vision.recognize(b"\x89PNG", "image/png", "2026-09-25", "Asia/Shanghai")
    assert failure.value.code == ErrorCode.THIRD_PARTY_UNAVAILABLE
    assert "识别服务未配置" in failure.value.message
