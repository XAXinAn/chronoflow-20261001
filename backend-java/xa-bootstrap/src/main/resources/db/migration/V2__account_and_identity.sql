-- 账号、身份与登录日志。见 spec §3.1、§5.3。
-- 核心约束：一个账号至多 1 个个人身份；同一组织至多 1 个组织身份。

CREATE TABLE account (
    id                BIGSERIAL PRIMARY KEY,
    phone             VARCHAR(20)  NOT NULL,
    phone_verified_at TIMESTAMPTZ,
    password_hash     VARCHAR(100),
    wechat_unionid    VARCHAR(64),
    wechat_openid     VARCHAR(64),
    email             VARCHAR(128),
    email_verified_at TIMESTAMPTZ,
    status            VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
    last_login_at     TIMESTAMPTZ,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uk_account_phone UNIQUE (phone),
    CONSTRAINT ck_account_status CHECK (status IN ('ACTIVE', 'DISABLED'))
);

CREATE UNIQUE INDEX uk_account_wechat_unionid
    ON account (wechat_unionid) WHERE wechat_unionid IS NOT NULL;
CREATE UNIQUE INDEX uk_account_email
    ON account (email) WHERE email IS NOT NULL;

CREATE TABLE identity (
    id            BIGSERIAL PRIMARY KEY,
    account_id    BIGINT      NOT NULL,
    identity_type VARCHAR(16) NOT NULL,
    org_id        BIGINT,
    nickname      VARCHAR(64),
    avatar_url    VARCHAR(512),
    status        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_identity_account FOREIGN KEY (account_id) REFERENCES account (id),
    CONSTRAINT fk_identity_org FOREIGN KEY (org_id) REFERENCES organization (id),
    CONSTRAINT ck_identity_type CHECK (identity_type IN ('PERSONAL', 'ORG_MEMBER')),
    CONSTRAINT ck_identity_status CHECK (status IN ('ACTIVE', 'DISABLED')),
    -- 个人身份不带组织；组织身份必须带组织
    CONSTRAINT ck_identity_org_scope CHECK (
        (identity_type = 'PERSONAL' AND org_id IS NULL)
        OR (identity_type = 'ORG_MEMBER' AND org_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uk_identity_personal
    ON identity (account_id) WHERE identity_type = 'PERSONAL';
CREATE UNIQUE INDEX uk_identity_org_member
    ON identity (account_id, org_id) WHERE identity_type = 'ORG_MEMBER';
CREATE INDEX idx_identity_account ON identity (account_id);

CREATE TABLE login_log (
    id             BIGSERIAL PRIMARY KEY,
    principal_type VARCHAR(16) NOT NULL,
    account_id     BIGINT,
    admin_user_id  BIGINT,
    identity_id    BIGINT,
    login_type     VARCHAR(24) NOT NULL,
    result         VARCHAR(16) NOT NULL,
    fail_reason    VARCHAR(128),
    ip             VARCHAR(64),
    user_agent     VARCHAR(512),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_login_log_account FOREIGN KEY (account_id) REFERENCES account (id),
    CONSTRAINT fk_login_log_admin FOREIGN KEY (admin_user_id) REFERENCES admin_user (id),
    CONSTRAINT fk_login_log_identity FOREIGN KEY (identity_id) REFERENCES identity (id),
    CONSTRAINT ck_login_log_principal CHECK (principal_type IN ('ACCOUNT', 'ADMIN')),
    CONSTRAINT ck_login_log_result CHECK (result IN ('SUCCESS', 'FAIL'))
);

CREATE INDEX idx_login_log_created ON login_log (created_at DESC);
CREATE INDEX idx_login_log_account ON login_log (account_id, created_at DESC);
