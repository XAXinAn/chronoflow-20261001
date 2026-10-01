-- 节假日与调休（spec §5.11）。搜索（spec §4.1.7 / §6.2 GET /search）不需要新表，
-- 直接在现有的 event / task 上做子串匹配，这里只加节假日数据源。
--
-- 这个迁移**只建表，不塞任何数据**：
--   节假日是运营数据，不是 schema。数据放 scripts/data/holidays/*.json，
--   由 scripts/load_holidays.py 幂等 upsert 入库（路径可配置：--dir / XATODO_HOLIDAY_DIR）。
--   一旦把某年的放假安排写进迁移，改一次数据就得加一个迁移文件、发一次版，
--   而「调休上班日以国务院办公厅当年通知为准」本身就是要随通知更正的——
--   用迁移装数据等于把易变数据冻进了不可变的 schema 历史里。
--
-- 为什么用 DATE 而不是 TIMESTAMPTZ：
--   节假日是「哪一天」，与时区无关。用时间戳会引入「东八区 10-01 00:00 在 UTC 是 09-30」
--   这类歧义，日历格子按日期比对时就会错位一天。

CREATE TABLE holiday (
    id           BIGSERIAL PRIMARY KEY,
    country_code VARCHAR(16) NOT NULL,
    holiday_date DATE        NOT NULL,
    name         VARCHAR(64) NOT NULL,
    day_type     VARCHAR(16) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 热更新按这个唯一键 upsert：脚本重复执行不会灌出重复数据
    CONSTRAINT uk_holiday_country_date UNIQUE (country_code, holiday_date),
    CONSTRAINT ck_holiday_day_type CHECK (day_type IN ('HOLIDAY', 'WORKDAY'))
);

-- GET /holidays?year=&month= 的取数路径：按国家 + 日期范围
CREATE INDEX idx_holiday_country_date ON holiday (country_code, holiday_date);
