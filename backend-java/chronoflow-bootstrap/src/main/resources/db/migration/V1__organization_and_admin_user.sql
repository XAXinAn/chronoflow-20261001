-- 组织（租户）与后台管理员。见 spec §5.4、§5.3。
-- organization.created_by_admin_id 与 admin_user.org_id 互相引用，故先建表后补外键。

CREATE TABLE organization (
    id                  BIGSERIAL PRIMARY KEY,
    name                VARCHAR(128) NOT NULL,
    code                VARCHAR(64)  NOT NULL,
    logo_url            VARCHAR(512),
    contact_name        VARCHAR(64),
    contact_phone       VARCHAR(20),
    timezone            VARCHAR(64)  NOT NULL DEFAULT 'Asia/Shanghai',
    status              VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
    max_members         INTEGER      NOT NULL DEFAULT 100,
    expire_at           TIMESTAMPTZ,
    created_by_admin_id BIGINT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT uk_organization_code UNIQUE (code),
    CONSTRAINT ck_organization_status CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DISABLED')),
    CONSTRAINT ck_organization_max_members CHECK (max_members > 0)
);

CREATE TABLE admin_user (
    id                 BIGSERIAL PRIMARY KEY,
    username           VARCHAR(64)  NOT NULL,
    password_hash      VARCHAR(100) NOT NULL,
    real_name          VARCHAR(64),
    phone              VARCHAR(20),
    email              VARCHAR(128),
    role               VARCHAR(16)  NOT NULL,
    org_id             BIGINT,
    mfa_enabled        BOOLEAN      NOT NULL DEFAULT FALSE,
    mfa_secret         VARCHAR(64),
    status             VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
    last_login_at      TIMESTAMPTZ,
    failed_login_count INTEGER      NOT NULL DEFAULT 0,
    locked_until       TIMESTAMPTZ,
    created_by         BIGINT,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uk_admin_user_username UNIQUE (username),
    CONSTRAINT fk_admin_user_org FOREIGN KEY (org_id) REFERENCES organization (id),
    CONSTRAINT fk_admin_user_created_by FOREIGN KEY (created_by) REFERENCES admin_user (id),
    CONSTRAINT ck_admin_user_role CHECK (role IN ('SUPER_ADMIN', 'ORG_ADMIN')),
    CONSTRAINT ck_admin_user_status CHECK (status IN ('ACTIVE', 'DISABLED')),
    -- 超管不绑定组织；组织管理员必须绑定组织
    CONSTRAINT ck_admin_user_role_org CHECK (
        (role = 'SUPER_ADMIN' AND org_id IS NULL)
        OR (role = 'ORG_ADMIN' AND org_id IS NOT NULL)
    )
);

ALTER TABLE organization
    ADD CONSTRAINT fk_organization_created_by_admin
        FOREIGN KEY (created_by_admin_id) REFERENCES admin_user (id);

CREATE INDEX idx_admin_user_org ON admin_user (org_id);
