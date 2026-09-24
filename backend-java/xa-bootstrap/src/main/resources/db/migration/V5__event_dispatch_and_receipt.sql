-- 组织日程下发与成员回执。见 spec §5.6。
-- 下发时按目标范围展开为 event_recipient 快照，后续新入组成员不补收历史日程。

CREATE TABLE event_dispatch (
    id                      BIGSERIAL PRIMARY KEY,
    event_id                BIGINT      NOT NULL,
    org_id                  BIGINT      NOT NULL,
    scope_type              VARCHAR(16) NOT NULL,
    department_id           BIGINT,
    include_sub_departments BOOLEAN     NOT NULL DEFAULT TRUE,
    require_receipt         BOOLEAN     NOT NULL DEFAULT FALSE,
    created_by_member_id    BIGINT      NOT NULL,
    status                  VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    recipient_count         INTEGER     NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_dispatch_event FOREIGN KEY (event_id) REFERENCES event (id),
    CONSTRAINT fk_dispatch_org FOREIGN KEY (org_id) REFERENCES organization (id),
    CONSTRAINT fk_dispatch_department FOREIGN KEY (department_id) REFERENCES department (id),
    CONSTRAINT fk_dispatch_creator FOREIGN KEY (created_by_member_id) REFERENCES org_member (id),
    CONSTRAINT ck_dispatch_scope CHECK (scope_type IN ('ALL', 'DEPARTMENT', 'MEMBER')),
    CONSTRAINT ck_dispatch_status CHECK (status IN ('ACTIVE', 'REVOKED')),
    -- 按部门下发时必须指定部门
    CONSTRAINT ck_dispatch_scope_department CHECK (
        (scope_type = 'DEPARTMENT' AND department_id IS NOT NULL)
        OR scope_type <> 'DEPARTMENT'
    )
);

CREATE INDEX idx_dispatch_event ON event_dispatch (event_id);
CREATE INDEX idx_dispatch_org ON event_dispatch (org_id, status);

ALTER TABLE event
    ADD CONSTRAINT fk_event_dispatch
        FOREIGN KEY (dispatch_id) REFERENCES event_dispatch (id);

CREATE TABLE event_recipient (
    id              BIGSERIAL PRIMARY KEY,
    dispatch_id     BIGINT      NOT NULL,
    event_id        BIGINT      NOT NULL,
    org_member_id   BIGINT      NOT NULL,
    department_id   BIGINT      NOT NULL,
    receipt_status  VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    receipt_at      TIMESTAMPTZ,
    remark          VARCHAR(512),
    read_at         TIMESTAMPTZ,
    occurrence_date DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_recipient_dispatch FOREIGN KEY (dispatch_id) REFERENCES event_dispatch (id) ON DELETE CASCADE,
    CONSTRAINT fk_recipient_event FOREIGN KEY (event_id) REFERENCES event (id),
    CONSTRAINT fk_recipient_member FOREIGN KEY (org_member_id) REFERENCES org_member (id),
    CONSTRAINT fk_recipient_department FOREIGN KEY (department_id) REFERENCES department (id),
    CONSTRAINT ck_recipient_status CHECK (receipt_status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'COMPLETED'))
);

CREATE UNIQUE INDEX uk_recipient ON event_recipient (
    dispatch_id, org_member_id, COALESCE(occurrence_date, '-infinity'::date)
);
CREATE INDEX idx_recipient_member ON event_recipient (org_member_id, receipt_status);
CREATE INDEX idx_recipient_event ON event_recipient (event_id, receipt_status);
