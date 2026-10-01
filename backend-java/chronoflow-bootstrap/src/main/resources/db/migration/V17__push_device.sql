-- 推送设备注册表（spec §4.5）。
--
-- 为什么要有这张表：极光等推送通道发消息时用的是**设备标识（registrationId）**，
-- 而那个标识只有 App 在设备上初始化 SDK 之后才能拿到 —— 服务端必须让 App 主动上报并保存，
-- 否则「组织日程下发」这类**由服务端触发**的通知根本不知道该往哪台设备发。
--
-- 一行 = 一台设备上的一个推送标识。同一账号可以有多台设备，同一台设备换账号登录也会产生新行，
-- 因此唯一键是 (provider, registration_id)（一个标识只属于一个账号，重新登录时改绑而不是新增）。

CREATE TABLE push_device (
    id                BIGSERIAL PRIMARY KEY,
    account_id        BIGINT      NOT NULL,
    identity_id       BIGINT      NOT NULL,
    provider          VARCHAR(16) NOT NULL DEFAULT 'jpush',
    -- 极光的 registrationId；长度给足，别按现在的样子收紧
    registration_id   VARCHAR(128) NOT NULL,
    platform          VARCHAR(16),
    app_version       VARCHAR(32),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 通道回执说这个标识失效时置位，不再对它发；用户重新登录会刷新
    disabled_at       TIMESTAMPTZ,
    CONSTRAINT fk_push_device_account FOREIGN KEY (account_id) REFERENCES account (id),
    CONSTRAINT fk_push_device_identity FOREIGN KEY (identity_id) REFERENCES identity (id),
    CONSTRAINT ck_push_device_provider CHECK (provider IN ('jpush')),
    CONSTRAINT ck_push_device_platform CHECK (platform IS NULL OR platform IN ('android', 'ios'))
);

-- 同一个推送标识只保留一行：换账号登录时改绑，而不是让两台设备共用一个标识
CREATE UNIQUE INDEX uk_push_device_registration ON push_device (provider, registration_id);
-- 发推送时按身份查该身份名下的活跃设备
CREATE INDEX idx_push_device_identity ON push_device (identity_id) WHERE disabled_at IS NULL;
