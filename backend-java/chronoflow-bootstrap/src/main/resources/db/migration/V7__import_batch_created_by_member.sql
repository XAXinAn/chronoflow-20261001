-- 组织管理端的成员导入由「组织身份（org_member）」发起，而非后台 admin_user。
-- 原 created_by_admin_id 保留给平台超管后台路径使用，因此放开非空约束并补充成员列。

ALTER TABLE import_batch ALTER COLUMN created_by_admin_id DROP NOT NULL;

ALTER TABLE import_batch
    ADD COLUMN created_by_member_id BIGINT,
    ADD CONSTRAINT fk_import_batch_member
        FOREIGN KEY (created_by_member_id) REFERENCES org_member (id);

CREATE INDEX idx_import_batch_member ON import_batch (created_by_member_id);
