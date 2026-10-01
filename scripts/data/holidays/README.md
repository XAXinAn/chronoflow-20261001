# 节假日数据（holiday）

这里放的是 `holiday` 表的**数据源**，不是代码。表结构由 Flyway 管理（`V11__holiday_calendar.sql`，
只建表不塞数据），数据一律经 `scripts/load_holidays.py` upsert 入库。

## 文件从哪来

`YYYY.json` 是 [holiday-cn](https://github.com/NateScarlet/holiday-cn) 的**原样拷贝**。
该仓库把国务院办公厅每年的放假通知整理成 JSON：

- `days[].isOffDay = true` → 放假（`HOLIDAY`）
- `days[].isOffDay = false` → 调休上班（`WORKDAY`）
- `papers[]` → 通知原文链接，会随加载结果一起打印出来，便于核对

自己手抄农历日期既容易出错、也说不清出处，所以直接用它。**不要手工编辑这里的日期**——
要改就重新从上游拉一次。

## 怎么更新

```bash
# 新增 / 刷新某一年（下载到本目录后自动灌库）
backend-python/.venv/bin/python scripts/load_holidays.py \
    --url https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2027.json

# 只灌本目录已有的文件（幂等，可反复执行）
backend-python/.venv/bin/python scripts/load_holidays.py

# 上游撤掉某个调休日时，顺带删掉该国家日历里不在文件中的行
backend-python/.venv/bin/python scripts/load_holidays.py --prune
```

生产环境可以把目录换到运维自己的位置：`--dir /etc/chronoflow/holidays` 或环境变量 `CHRONOFLOW_HOLIDAY_DIR`。
后端有 5 分钟缓存（spec §5.11），所以数据变更最迟 5 分钟生效，不需要重启服务。

## 没有数据时会怎样

某一年没有对应的文件、库里也没有记录时，`GET /holidays` 返回空数组，日历上不显示任何休/班标记。
**这是有意为之**：不猜测、不用硬编码兜底，缺数据就要能被看出来。
