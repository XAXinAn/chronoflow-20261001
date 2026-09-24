-- 部门树、组织成员与部门管理员。见 spec §5.4。
-- 部门使用物化路径 path（形如 /1/5/12/）支撑「本部门及所有下级」的递归权限判定。

CREATE TABLE department (
    id               BIGSERIAL PRIMARY KEY,
    org_id           BIGINT       NOT NULL,
    parent_id        BIGINT,
    name             VARCHAR(64)  NOT NULL,
    path             VARCHAR(255) NOT NULL,
    level            SMALLINT     NOT NULL,
    sort_order       INTEGER      NOT NULL DEFAULT 0,
    leader_member_id BIGINT,
    status           VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_department_org FOREIGN KEY (org_id) REFERENCES organization (id),
    CONSTRAINT fk_department_parent FOREIGN KEY (parent_id) REFERENCES department (id),
    CONSTRAINT ck_department_level CHECK (level BETWEEN 1 AND 5),
    CONSTRAINT ck_department_status CHECK (status IN ('ACTIVE', 'DISABLED'))
);

-- 同级部门重名约束：根部门与子部门分别处理（NULL 不参与唯一比较）
CREATE UNIQUE INDEX uk_department_root_name
    ON department (org_id, name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX uk_department_child_name
    ON department (org_id, parent_id, name) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_department_org_path ON department (org_id, path);

CREATE TABLE org_member (
    id            BIGSERIAL PRIMARY KEY,
    org_id        BIGINT       NOT NULL,
    identity_id   BIGINT       NOT NULL,
    department_id BIGINT       NOT NULL,
    member_no     VARCHAR(64),
    real_name     VARCHAR(64)  NOT NULL,
    org_role      VARCHAR(16)  NOT NULL DEFAULT 'MEMBER',
    job_title     VARCHAR(64),
    status        VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
    joined_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_org_member_org FOREIGN KEY (org_id) REFERENCES organization (id),
    CONSTRAINT fk_org_member_identity FOREIGN KEY (identity_id) REFERENCES identity (id),
    CONSTRAINT fk_org_member_department FOREIGN KEY (department_id) REFERENCES department (id),
    CONSTRAINT ck_org_member_role CHECK (org_role IN ('OWNER', 'ADMIN', 'MEMBER')),
    CONSTRAINT ck_org_member_status CHECK (status IN ('ACTIVE', 'DISABLED', 'LEFT'))
);

CREATE UNIQUE INDEX uk_org_member_identity ON org_member (org_id, identity_id);
CREATE UNIQUE INDEX uk_org_member_no ON org_member (org_id, member_no) WHERE member_no IS NOT NULL;
-- 组织拥有者唯一
CREATE UNIQUE INDEX uk_org_member_owner ON org_member (org_id) WHERE org_role = 'OWNER';
CREATE INDEX idx_org_member_department ON org_member (org_id, department_id, status);

ALTER TABLE department
    ADD CONSTRAINT fk_department_leader
        FOREIGN KEY (leader_member_id) REFERENCES org_member (id);

CREATE TABLE department_manager (
    id                  BIGSERIAL PRIMARY KEY,
    department_id       BIGINT      NOT NULL,
    org_member_id       BIGINT      NOT NULL,
    granted_by_admin_id BIGINT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_dept_manager_department FOREIGN KEY (department_id) REFERENCES department (id),
    CONSTRAINT fk_dept_manager_member FOREIGN KEY (org_member_id) REFERENCES org_member (id),
    CONSTRAINT fk_dept_manager_admin FOREIGN KEY (granted_by_admin_id) REFERENCES admin_user (id)
);

CREATE UNIQUE INDEX uk_department_manager ON department_manager (department_id, org_member_id);
CREATE INDEX idx_department_manager_member ON department_manager (org_member_id);
