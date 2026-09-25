-- 待办关联日程：一个日程可关联多个待办，一个待办至多关联一个日程。见 spec §4.1.6 / §5.5。
--
-- 设计要点：
--   1) 只在待办侧加外键，天然就是「一对多」，不需要中间表；
--   2) 日程是软删除（deleted_at），所以外键不会自动置空——删除日程时由服务层显式解除关联，
--      保证「删日程不删待办」这条 spec 要求。

ALTER TABLE task ADD COLUMN event_id BIGINT;

ALTER TABLE task
    ADD CONSTRAINT fk_task_event FOREIGN KEY (event_id) REFERENCES event (id);

-- 「这个日程下挂了哪些待办」要按 event_id 反查
CREATE INDEX idx_task_event ON task (event_id) WHERE event_id IS NOT NULL;
