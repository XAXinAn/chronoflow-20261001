-- 日历、日程、重复例外、待办与提醒。见 spec §5.5。

CREATE TABLE calendar (
    id                BIGSERIAL PRIMARY KEY,
    calendar_type     VARCHAR(16)  NOT NULL,
    owner_identity_id BIGINT,
    org_id            BIGINT,
    department_id     BIGINT,
    name              VARCHAR(64)  NOT NULL,
    color             VARCHAR(16)  NOT NULL DEFAULT '#0A0A0A',
    timezone          VARCHAR(64)  NOT NULL DEFAULT 'Asia/Shanghai',
    is_default        BOOLEAN      NOT NULL DEFAULT FALSE,
    status            VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_calendar_identity FOREIGN KEY (owner_identity_id) REFERENCES identity (id),
    CONSTRAINT fk_calendar_org FOREIGN KEY (org_id) REFERENCES organization (id),
    CONSTRAINT fk_calendar_department FOREIGN KEY (department_id) REFERENCES department (id),
    CONSTRAINT ck_calendar_type CHECK (calendar_type IN ('PERSONAL', 'ORG', 'ORG_DEPARTMENT')),
    CONSTRAINT ck_calendar_status CHECK (status IN ('ACTIVE', 'DISABLED')),
    -- 个人日历归属身份；组织/部门日历归属组织
    CONSTRAINT ck_calendar_owner CHECK (
        (calendar_type = 'PERSONAL' AND owner_identity_id IS NOT NULL AND org_id IS NULL)
        OR (calendar_type IN ('ORG', 'ORG_DEPARTMENT') AND org_id IS NOT NULL AND owner_identity_id IS NULL)
    )
);

CREATE UNIQUE INDEX uk_calendar_personal_default
    ON calendar (owner_identity_id) WHERE calendar_type = 'PERSONAL' AND is_default;
CREATE INDEX idx_calendar_org ON calendar (org_id);

CREATE TABLE event (
    id                     BIGSERIAL PRIMARY KEY,
    calendar_id            BIGINT       NOT NULL,
    org_id                 BIGINT,
    creator_identity_id    BIGINT       NOT NULL,
    source_type            VARCHAR(16)  NOT NULL DEFAULT 'PERSONAL',
    title                  VARCHAR(200) NOT NULL,
    description            TEXT,
    location               VARCHAR(255),
    start_at               TIMESTAMPTZ  NOT NULL,
    end_at                 TIMESTAMPTZ  NOT NULL,
    all_day                BOOLEAN      NOT NULL DEFAULT FALSE,
    timezone               VARCHAR(64)  NOT NULL DEFAULT 'Asia/Shanghai',
    rrule                  VARCHAR(512),
    rrule_until            TIMESTAMPTZ,
    status                 VARCHAR(16)  NOT NULL DEFAULT 'CONFIRMED',
    dispatch_id            BIGINT,
    updated_after_dispatch BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at             TIMESTAMPTZ,
    CONSTRAINT fk_event_calendar FOREIGN KEY (calendar_id) REFERENCES calendar (id),
    CONSTRAINT fk_event_org FOREIGN KEY (org_id) REFERENCES organization (id),
    CONSTRAINT fk_event_creator FOREIGN KEY (creator_identity_id) REFERENCES identity (id),
    CONSTRAINT ck_event_source CHECK (source_type IN ('PERSONAL', 'ORG_DISPATCH')),
    CONSTRAINT ck_event_status CHECK (status IN ('CONFIRMED', 'CANCELLED')),
    CONSTRAINT ck_event_time CHECK (end_at > start_at)
);

CREATE INDEX idx_event_calendar_range ON event (calendar_id, start_at, end_at);
CREATE INDEX idx_event_org_range ON event (org_id, start_at);
CREATE INDEX idx_event_creator ON event (creator_identity_id);

CREATE TABLE event_exception (
    id                BIGSERIAL PRIMARY KEY,
    event_id          BIGINT       NOT NULL,
    occurrence_date   DATE         NOT NULL,
    exception_type    VARCHAR(16)  NOT NULL,
    override_start_at TIMESTAMPTZ,
    override_end_at   TIMESTAMPTZ,
    override_title    VARCHAR(200),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_event_exception_event FOREIGN KEY (event_id) REFERENCES event (id) ON DELETE CASCADE,
    CONSTRAINT ck_event_exception_type CHECK (exception_type IN ('MODIFIED', 'CANCELLED')),
    CONSTRAINT ck_event_exception_time CHECK (
        override_start_at IS NULL OR override_end_at IS NULL OR override_end_at > override_start_at
    )
);

CREATE UNIQUE INDEX uk_event_exception ON event_exception (event_id, occurrence_date);

CREATE TABLE task (
    id                BIGSERIAL PRIMARY KEY,
    calendar_id       BIGINT       NOT NULL,
    owner_identity_id BIGINT       NOT NULL,
    org_id            BIGINT,
    parent_task_id    BIGINT,
    title             VARCHAR(200) NOT NULL,
    description       TEXT,
    due_at            TIMESTAMPTZ,
    all_day           BOOLEAN      NOT NULL DEFAULT FALSE,
    status            VARCHAR(16)  NOT NULL DEFAULT 'TODO',
    completed_at      TIMESTAMPTZ,
    priority          VARCHAR(16)  NOT NULL DEFAULT 'NORMAL',
    rrule             VARCHAR(512),
    sort_order        INTEGER      NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ,
    CONSTRAINT fk_task_calendar FOREIGN KEY (calendar_id) REFERENCES calendar (id),
    CONSTRAINT fk_task_owner FOREIGN KEY (owner_identity_id) REFERENCES identity (id),
    CONSTRAINT fk_task_org FOREIGN KEY (org_id) REFERENCES organization (id),
    CONSTRAINT fk_task_parent FOREIGN KEY (parent_task_id) REFERENCES task (id),
    CONSTRAINT ck_task_status CHECK (status IN ('TODO', 'DONE', 'CANCELLED')),
    CONSTRAINT ck_task_priority CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
    -- 子任务不允许再有子任务（仅两层）
    CONSTRAINT ck_task_not_self_parent CHECK (parent_task_id IS NULL OR parent_task_id <> id)
);

CREATE INDEX idx_task_owner_status_due ON task (owner_identity_id, status, due_at);
CREATE INDEX idx_task_calendar ON task (calendar_id);

-- target_id 为多态引用（EVENT / TASK），故不建外键，由应用层保证一致性。
CREATE TABLE reminder (
    id              BIGSERIAL PRIMARY KEY,
    target_type     VARCHAR(16) NOT NULL,
    target_id       BIGINT      NOT NULL,
    identity_id     BIGINT      NOT NULL,
    occurrence_date DATE,
    minutes_before  INTEGER     NOT NULL,
    channel         VARCHAR(16) NOT NULL DEFAULT 'PUSH',
    enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_reminder_identity FOREIGN KEY (identity_id) REFERENCES identity (id),
    CONSTRAINT ck_reminder_target CHECK (target_type IN ('EVENT', 'TASK')),
    CONSTRAINT ck_reminder_channel CHECK (channel IN ('PUSH', 'LOCAL')),
    CONSTRAINT ck_reminder_minutes CHECK (minutes_before >= 0)
);

CREATE UNIQUE INDEX uk_reminder ON reminder (
    target_type, target_id, identity_id, COALESCE(occurrence_date, '-infinity'::date), minutes_before
);
