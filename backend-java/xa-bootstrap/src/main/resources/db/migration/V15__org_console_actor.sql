-- 组织管理端（Web）由后台 admin_user 操作，而它没有 C 端身份（spec §4.3 / §3.2）。
-- 因此「日程是谁创建的」「下发是谁发起的」需要能落到 admin_user 上。
-- 见 spec §5.5（event.creator_identity_id 可空）与 §5.6（event_dispatch 新增 created_by_admin_id）。

ALTER TABLE event ALTER COLUMN creator_identity_id DROP NOT NULL;

ALTER TABLE event_dispatch ALTER COLUMN created_by_member_id DROP NOT NULL;
ALTER TABLE event_dispatch ADD COLUMN created_by_admin_id BIGINT;
ALTER TABLE event_dispatch
    ADD CONSTRAINT fk_dispatch_admin FOREIGN KEY (created_by_admin_id) REFERENCES admin_user (id);
CREATE INDEX idx_dispatch_admin ON event_dispatch (created_by_admin_id);

-- 发起方恰有一列非空：成员（App 组织身份）或后台组织管理员（Web）。
-- 两列都空等于「谁也不认这笔下发」，比缺字段更难查。
ALTER TABLE event_dispatch
    ADD CONSTRAINT ck_dispatch_creator CHECK (
        (created_by_member_id IS NOT NULL AND created_by_admin_id IS NULL)
        OR (created_by_member_id IS NULL AND created_by_admin_id IS NOT NULL)
    );
