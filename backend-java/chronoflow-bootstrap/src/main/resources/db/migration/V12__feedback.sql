-- 意见反馈（spec §4.1.9 / §5.10）。图片本身走文件存储（/uploads/**），这里只存相对 URL 数组。
--
-- 记 identity_id 而不只是 account_id：
--   用户可能是从组织身份提交的（「我们部门的组织日程看不到回执」）。
--   只记到账号，后台就不知道是哪条身份说的，回访时还得猜。

CREATE TABLE feedback (
    id                   BIGSERIAL PRIMARY KEY,
    account_id           BIGINT NOT NULL,
    identity_id          BIGINT NOT NULL,
    category             VARCHAR(32) NOT NULL,
    content              TEXT        NOT NULL,
    -- jsonb：图片是「一组相对 URL」，数量不定，用数组列而不是拼接字符串
    images               JSONB       NOT NULL DEFAULT '[]'::jsonb,
    status               VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    handled_at           TIMESTAMPTZ,
    handled_by_admin_id  BIGINT,
    CONSTRAINT ck_feedback_category CHECK (category IN ('BUG', 'SUGGESTION', 'OTHER')),
    CONSTRAINT ck_feedback_status CHECK (status IN ('OPEN', 'HANDLED')),
    -- 处理人只可能和处理时间一起出现，避免出现「已处理但不知道谁处理的」半截状态
    CONSTRAINT ck_feedback_handled CHECK (
        (status = 'OPEN' AND handled_at IS NULL AND handled_by_admin_id IS NULL)
        OR (status = 'HANDLED' AND handled_at IS NOT NULL)
    )
);

-- 「我提交过的反馈」按账号 + 时间倒序
CREATE INDEX idx_feedback_account ON feedback (account_id, created_at DESC);
-- 超管工作台默认只看待处理的
CREATE INDEX idx_feedback_status ON feedback (status, created_at DESC);
