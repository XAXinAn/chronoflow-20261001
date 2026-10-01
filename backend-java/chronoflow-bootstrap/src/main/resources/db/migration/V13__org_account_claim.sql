-- 组织账号改为「认领」模型（spec §3.1 / §3.2 / §5.4）：
--   管理员导入/新增成员时**只需写成员唯一识别 ID**（学号/工号），不再需要手机号或初始密码；
--   成员在 App 里用「组织唯一 ID + 唯一识别 ID」认领这个组织账号，认领即绑定。
--
-- 三处结构变化：
--   1) member_no → member_key，并改为「组织内唯一且非空」——它就是成员标识本身，
--      不再是一个可选的工号备注；
--   2) identity_id 改为可空：成员先由管理员导入，**身份在成员认领时才产生**
--      （原先「创建成员需要组织身份令牌、而首位成员没有身份」正是卡住新组织的原因）；
--   3) 记录 last_login_at，供 App 的「账户管理」显示最近登录时间。
--
-- 不存组织侧密码：首版是认领模型（唯一识别 ID 通常不是秘密，取舍见 spec §3.1 的安全说明）。

ALTER TABLE org_member RENAME COLUMN member_no TO member_key;

-- 旧的部分唯一索引跟着列走，语义已被「非空唯一」取代，删掉以免两套键并存
DROP INDEX uk_org_member_no;

-- 历史数据回填：没有 member_key 的行用 id 生成一个占位值，
-- 保证非空约束能加上；这类占位值一眼能看出来，便于组织管理员改名
UPDATE org_member SET member_key = 'M' || id WHERE member_key IS NULL;

ALTER TABLE org_member ALTER COLUMN member_key SET NOT NULL;
CREATE UNIQUE INDEX uk_org_member_key ON org_member (org_id, member_key);

-- 成员先导入、认领时才产生身份
ALTER TABLE org_member ALTER COLUMN identity_id DROP NOT NULL;

ALTER TABLE org_member ADD COLUMN last_login_at TIMESTAMPTZ;
