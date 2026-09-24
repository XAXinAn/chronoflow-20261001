-- 成员批量导入、审计日志与全局配置。见 spec §5.7。

CREATE TABLE import_batch (
    id                  BIGSERIAL PRIMARY KEY,
    org_id              BIGINT       NOT NULL,
    file_name           VARCHAR(255) NOT NULL,
    file_url            VARCHAR(512) NOT NULL,
    total_count         INTEGER      NOT NULL DEFAULT 0,
    success_count       INTEGER      NOT NULL DEFAULT 0,
    fail_count          INTEGER      NOT NULL DEFAULT 0,
    status              VARCHAR(24)  NOT NULL DEFAULT 'PROCESSING',
    created_by_admin_id BIGINT       NOT NULL,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ,
    CONSTRAINT fk_import_batch_org FOREIGN KEY (org_id) REFERENCES organization (id),
    CONSTRAINT fk_import_batch_admin FOREIGN KEY (created_by_admin_id) REFERENCES admin_user (id),
    CONSTRAINT ck_import_batch_status CHECK (status IN ('PROCESSING', 'SUCCESS', 'PARTIAL_FAILED', 'FAILED'))
);

CREATE INDEX idx_import_batch_org ON import_batch (org_id, created_at DESC);

CREATE TABLE import_row_result (
    id                BIGSERIAL PRIMARY KEY,
    batch_id          BIGINT      NOT NULL,
    row_no            INTEGER     NOT NULL,
    raw_data          JSONB,
    status            VARCHAR(16) NOT NULL,
    error_message     VARCHAR(512),
    created_member_id BIGINT,
    CONSTRAINT fk_import_row_batch FOREIGN KEY (batch_id) REFERENCES import_batch (id) ON DELETE CASCADE,
    CONSTRAINT fk_import_row_member FOREIGN KEY (created_member_id) REFERENCES org_member (id),
    CONSTRAINT ck_import_row_status CHECK (status IN ('SUCCESS', 'FAILED'))
);

CREATE INDEX idx_import_row_batch ON import_row_result (batch_id, status);

-- 审计日志仅追加，禁止修改与删除（spec §7.1）
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    actor_type  VARCHAR(16) NOT NULL,
    actor_id    BIGINT,
    actor_name  VARCHAR(64),
    org_id      BIGINT,
    action      VARCHAR(64) NOT NULL,
    target_type VARCHAR(64),
    target_id   BIGINT,
    detail      JSONB,
    ip          VARCHAR(64),
    user_agent  VARCHAR(512),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_audit_log_org FOREIGN KEY (org_id) REFERENCES organization (id),
    CONSTRAINT ck_audit_log_actor CHECK (actor_type IN ('ACCOUNT', 'ADMIN'))
);

CREATE INDEX idx_audit_log_created ON audit_log (created_at DESC);
CREATE INDEX idx_audit_log_org ON audit_log (org_id, created_at DESC);
CREATE INDEX idx_audit_log_actor ON audit_log (actor_type, actor_id, created_at DESC);

CREATE TABLE system_config (
    id                  BIGSERIAL PRIMARY KEY,
    config_key          VARCHAR(64) NOT NULL,
    config_value        JSONB,
    description         VARCHAR(255),
    updated_by_admin_id BIGINT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_system_config_key UNIQUE (config_key),
    CONSTRAINT fk_system_config_admin FOREIGN KEY (updated_by_admin_id) REFERENCES admin_user (id)
);
