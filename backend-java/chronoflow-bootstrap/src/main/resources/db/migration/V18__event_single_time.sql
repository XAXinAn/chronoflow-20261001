-- 日程从「时间段」改成「时间点」（spec §4.1.2 / §4.1.4）。
--
-- 产品口径：日程只有一个时间，没有开始与结束。全天日程 = 「就这一天」，
-- 存当天 00:00 这一个点；不再支持跨天（原来的 end_at 表达不了，也不再需要）。
--
-- 存量数据：end_at 直接丢弃，at 由 start_at 回填——原来的开始时间就是用户心里那个时间。
ALTER TABLE event ADD COLUMN at TIMESTAMPTZ;
UPDATE event SET at = start_at;
ALTER TABLE event ALTER COLUMN at SET NOT NULL;
ALTER TABLE event DROP COLUMN start_at;
ALTER TABLE event DROP COLUMN end_at;

-- 丢掉列会连带把引用它的索引一起删掉（idx_event_calendar_range / idx_event_org_range），
-- 这里按新的时间点列重建，别让「按日历 + 时间」的查询退化成全表扫。
CREATE INDEX idx_event_calendar_at ON event (calendar_id, at);
CREATE INDEX idx_event_org_at ON event (org_id, at);

-- 重复日程的例外同样只覆盖一个时间点
ALTER TABLE event_exception ADD COLUMN override_at TIMESTAMPTZ;
UPDATE event_exception SET override_at = override_start_at;
ALTER TABLE event_exception DROP COLUMN override_start_at;
ALTER TABLE event_exception DROP COLUMN override_end_at;

COMMENT ON COLUMN event.at IS '日程的唯一时间点（全天日程为当天 00:00，timezone 字段说明按哪个时区理解）';
COMMENT ON COLUMN event_exception.override_at IS '重复日程的这一次，时间被单独改成了什么';
