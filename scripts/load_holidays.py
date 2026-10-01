#!/usr/bin/env python3
"""节假日数据加载器（spec §5.11）：把 JSON 数据文件 upsert 进 holiday 表。

为什么要有这个脚本：
    节假日是运营数据。它不进 Flyway 迁移、不写进任何 Java/Python 代码——迁移只建表。
    这样「换一年放假安排」「按官方通知更正一个调休日」都只是重跑一次脚本：
    不用发版、不用新增迁移、不用重启后端（服务端有 5 分钟缓存，见 spec §5.11）。

数据源：
    上游是 holiday-cn（https://github.com/NateScarlet/holiday-cn）：
    它把国务院办公厅每年的放假通知整理成 JSON，同时给出放假（isOffDay=true）与
    调休上班（isOffDay=false）两类日子，并在 papers 里保留通知原文链接。
    自己手抄农历日期既容易错、也说不清出处，所以直接用它的数据。

    脚本同时认两种格式（按 days 里有没有 isOffDay 自动判断）：
      1) holiday-cn 原始格式：{ year, papers[], days[{ name, date, isOffDay }] }
      2) 本服务自有格式：    { country, source, days[{ date, name, dayType }] }

幂等：
    按唯一键 (country_code, holiday_date) upsert，重复执行不会产生重复数据；
    上游撤掉某个调休日时，用 --prune 删掉该国家日历里不在数据文件中的行。

用法：
    # 灌入仓库自带的数据文件（scripts/data/holidays/*.json）
    backend-python/.venv/bin/python scripts/load_holidays.py

    # 新增一年的数据：先从上游拉到数据目录，再灌库
    backend-python/.venv/bin/python scripts/load_holidays.py \
        --url https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2027.json

    # 生产：指向运维自己的目录，顺带清理上游已撤掉的日子
    backend-python/.venv/bin/python scripts/load_holidays.py --dir /etc/chronoflow/holidays --prune
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import urllib.request
from datetime import date
from pathlib import Path

import psycopg

DB_URL = os.getenv("CHRONOFLOW_DB_URL", "postgresql://postgres@localhost:5432/chronoflow")
DEFAULT_DIR = Path(__file__).resolve().parent / "data" / "holidays"
DEFAULT_COUNTRY = "zh-CN"
DAY_TYPES = {"HOLIDAY", "WORKDAY"}


def _day(raw: dict, origin: str) -> tuple[date, str, str]:
    """把一条记录归一成 (日期, 名称, 类型)。脏数据在这一层就拦下来，别等落库后在界面上才发现。"""
    try:
        parsed = date.fromisoformat(str(raw["date"]))
    except (KeyError, ValueError) as exc:
        raise SystemExit(f"{origin}: 日期非法或缺失: {raw!r}") from exc

    name = str(raw.get("name") or "").strip()
    if not name:
        raise SystemExit(f"{origin}: {parsed} 缺少 name")

    if "isOffDay" in raw:
        # holiday-cn 格式：isOffDay=true 放假、false 调休上班
        day_type = "HOLIDAY" if raw["isOffDay"] else "WORKDAY"
    else:
        day_type = str(raw.get("dayType") or "").strip().upper()
    if day_type not in DAY_TYPES:
        raise SystemExit(
            f"{origin}: {parsed} 的 dayType 必须是 {'/'.join(sorted(DAY_TYPES))}，实际是 {raw!r}"
        )
    return parsed, name, day_type


def parse_payload(payload: dict, origin: str) -> tuple[str, list[tuple[date, str, str]], str | None]:
    country = str(payload.get("country") or DEFAULT_COUNTRY).strip()
    days = [_day(raw, origin) for raw in payload.get("days") or []]
    duplicates = [day for day, count in collections.Counter(d for d, _, _ in days).items() if count > 1]
    if duplicates:
        # 同一天两条记录会让「按唯一键 upsert」变成不确定行为，必须当场拒绝
        raise SystemExit(f"{origin}: 同一天出现多条记录: {sorted(duplicates)}")

    papers = payload.get("papers") or []
    provenance = papers[0] if papers else payload.get("source")
    return country, days, provenance


def read_file(path: Path) -> tuple[str, list[tuple[date, str, str]], str | None]:
    return parse_payload(json.loads(path.read_text(encoding="utf-8")), str(path))


def fetch(url: str, directory: Path) -> Path:
    """按 holiday-cn 的按年 URL 取名落盘，例如 .../2027.json → <data_dir>/2027.json。"""
    target = directory / Path(url).name
    with urllib.request.urlopen(url, timeout=30) as response:  # noqa: S310 - 地址来自显式参数
        body = response.read()
    target.write_bytes(body)
    print(f"已下载 {url}\n  → {target}（{len(body)} 字节）")
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description="把节假日 JSON 数据灌入 holiday 表（幂等）")
    parser.add_argument("--dir", default=os.getenv("CHRONOFLOW_HOLIDAY_DIR") or str(DEFAULT_DIR),
                        help="数据目录，目录下所有 *.json 都会被加载（默认 scripts/data/holidays）")
    parser.add_argument("--file", help="只加载单个文件（与 --dir 二选一）")
    parser.add_argument("--url", action="append", default=[],
                        help="从上游按年拉取（如 holiday-cn 的 2027.json），可重复；下载到 --dir 后一同加载")
    parser.add_argument("--database-url", default=DB_URL, help="PostgreSQL 连接串")
    parser.add_argument("--prune", action="store_true",
                        help="删除该国家日历里不在数据文件中的记录（上游撤掉某个调休日时用）")
    parser.add_argument("--dry-run", action="store_true", help="只校验、只打印，不写库")
    args = parser.parse_args()

    directory = Path(args.dir)
    for url in args.url:
        directory.mkdir(parents=True, exist_ok=True)
        fetch(url, directory)

    if args.file:
        files = [Path(args.file)]
    else:
        if not directory.is_dir():
            raise SystemExit(f"数据目录不存在: {directory}")
        files = sorted(directory.glob("*.json"))
    if not files:
        raise SystemExit("没有找到任何数据文件")

    datasets = [read_file(path) for path in files]
    total = sum(len(days) for _, days, _ in datasets)

    for path, (country, days, provenance) in zip(files, datasets):
        off = sum(1 for _, _, day_type in days if day_type == "HOLIDAY")
        print(f"  {path.name}: {country} · 放假 {off} 天 / 调休上班 {len(days) - off} 天"
              + (f"\n      来源: {provenance}" if provenance else ""))

    if args.dry_run:
        print(f"[dry-run] 共 {total} 条，未写库")
        return 0

    written = 0
    pruned = 0
    with psycopg.connect(args.database_url) as conn:
        with conn.cursor() as cur:
            for country, days, _ in datasets:
                for day, name, day_type in days:
                    # 唯一键 (country_code, holiday_date)：重跑是「更正」而不是「再插一条」
                    cur.execute(
                        """
                        INSERT INTO holiday (country_code, holiday_date, name, day_type)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (country_code, holiday_date)
                        DO UPDATE SET name = EXCLUDED.name,
                                      day_type = EXCLUDED.day_type,
                                      updated_at = now()
                        """,
                        (country, day, name, day_type),
                    )
                    written += cur.rowcount

                if not args.prune:
                    continue
                if not days:
                    # 空文件 + --prune 会把该国家日历清空。真要有意清空，先显式确认，别让它悄悄发生
                    print(f"  跳过 {country} 的 --prune：数据文件里一条记录都没有", file=sys.stderr)
                    continue
                cur.execute(
                    "DELETE FROM holiday WHERE country_code = %s AND NOT (holiday_date = ANY(%s))",
                    (country, [day for day, _, _ in days]),
                )
                pruned += cur.rowcount
        conn.commit()

    print(f"完成：写入/更新 {written} 条" + (f"，删除 {pruned} 条" if args.prune else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
