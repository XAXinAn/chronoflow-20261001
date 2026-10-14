-- 提醒改成**按日程/待办**配置：同一条日程的提醒共用一个「声音档」与一个「投递方式」。
--
-- 背景（用户试用反馈）：原来「提醒声音」是 App 里的**全局**设置，改一次影响所有日程，
-- 而真实需求是「这条日程要静音」「那条要闹钟式」。于是把声音档下沉到 `reminder` 上：
--
--   * `sound`   —— SILENT / DEFAULT / ALARM，对应 App 的三个通知渠道
--                  （Android 8 起渠道声音建好就改不了，所以三档 = 三个渠道 id）；
--   * `channel` —— 建表时就有的 PUSH / LOCAL。**到点提醒目前一律走 LOCAL**
--                  （App 本机通知：不依赖网络、不外传设备标识，spec §4.5）。
--                  服务端推送的链路还没接通（App 侧从未上报过设备标识，push_device 一直是空的），
--                  所以这里不引入 PUSH 语义，只把历史行从 PUSH 纠正成 LOCAL —— 它们本来就是本机提醒。
--
-- ⚠️ 历史行必须**改成 LOCAL**：旧代码插入时写死 `channel = 'PUSH'`，但那时根本没有任何
-- 推送调度器，App 一律把它们当本地提醒排。若照旧留着 PUSH，升级后这些提醒会被新的
-- 「PUSH 交给服务端」逻辑接管，而那些用户本来听得到的提醒会**直接不再响**。
ALTER TABLE reminder ADD COLUMN sound VARCHAR(16) NOT NULL DEFAULT 'DEFAULT';

ALTER TABLE reminder
    ADD CONSTRAINT ck_reminder_sound CHECK (sound IN ('SILENT', 'DEFAULT', 'ALARM'));

UPDATE reminder SET channel = 'LOCAL' WHERE channel = 'PUSH';

COMMENT ON COLUMN reminder.sound IS '提醒声音档（SILENT/DEFAULT/ALARM，spec §4.5）';
COMMENT ON COLUMN reminder.channel IS '投递方式（PUSH=服务端推送 / LOCAL=App 本机通知）';
