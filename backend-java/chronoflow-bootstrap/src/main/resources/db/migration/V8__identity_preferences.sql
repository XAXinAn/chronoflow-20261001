-- 账号设置：身份级时区与通知偏好（spec §6.2「账号设置」）。
-- 通知偏好按类型开关，存 jsonb 以便后续新增类型无需改表。

ALTER TABLE identity
    ADD COLUMN timezone VARCHAR(64),
    ADD COLUMN notification_prefs JSONB;
