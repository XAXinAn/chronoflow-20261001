-- 实名认证（阿里云 CloudAuth，ID_PRO：姓名 + 身份证 + 人脸活体）。
--
-- 口径：**登录后可选**（老项目是注册时强制，这里不沿用）。放「我的 → 账号与安全」，
-- 服务端未配置密钥时如实说「暂不可用」，绝不假装认证过。
--
-- 落在 `account` 而不是 `identity`：实名是**人**的属性（一个账号一份），
-- 与「个人身份 / 组织身份」这套身份切换无关（同 V2 里 email 放 account 的判断）。
--
-- 两个身份证号字段，用途不同、不要合并：
--   * `id_card_cipher`      密文（AES，随机 IV），只有要人工核对 / 展示时才解密；
--   * `id_card_fingerprint` HMAC-SHA256 指纹，**定长且确定性**，用来做
--     「同一实名信息只能绑一个账号」的唯一约束——密文带随机 IV 是没法比对的。
--
-- 邮箱绑定**不需要新字段**：V2 里 `account.email` / `email_verified_at` 与唯一索引都已经在了。

ALTER TABLE account
    ADD COLUMN real_name VARCHAR(64),
    ADD COLUMN id_card_cipher VARCHAR(255),
    ADD COLUMN id_card_fingerprint CHAR(64),
    ADD COLUMN real_name_verified BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN real_name_verified_at TIMESTAMPTZ;

-- 同一个人只能认证一个账号（换个账号再认证一次会被这条挡住，服务端翻译成 30008 一类的提示）
CREATE UNIQUE INDEX uk_account_id_card_fingerprint
    ON account (id_card_fingerprint) WHERE id_card_fingerprint IS NOT NULL;
