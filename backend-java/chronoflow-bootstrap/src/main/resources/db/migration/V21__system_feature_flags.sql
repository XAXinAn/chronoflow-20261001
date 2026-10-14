-- 全局配置的第一批**真实生效**的键：功能开关（spec §5.7 / §4.4）。
--
-- 背景：`system_config` 建表之后一直没有数据，后台「全局配置」页是一张空表，
-- 而且没有任何业务读这些值 —— 界面在、功能不在。这一版把「哪些入口可见」交给它管：
-- 超管改一下开关，App 下次进「我的」就能看到入口消失 / 回来，不用发版。
--
-- 默认全部为 true：升级之后行为与升级前一致，不会因为这条迁移把功能悄悄关掉。
-- `ON CONFLICT DO NOTHING` 保证重复执行（或已经被超管改过）时不会覆盖线上取值。

INSERT INTO system_config (config_key, config_value, description)
VALUES
    ('feature.feedback.enabled',      'true'::jsonb, 'App 的「意见反馈」入口是否可见'),
    ('feature.realname.enabled',      'true'::jsonb, 'App 的「实名认证」入口是否可见'),
    ('feature.email_binding.enabled', 'true'::jsonb, 'App 的「邮箱绑定」入口是否可见'),
    ('feature.agent.enabled',         'true'::jsonb, 'App 的「小安」智能助手是否可用')
ON CONFLICT (config_key) DO NOTHING;
