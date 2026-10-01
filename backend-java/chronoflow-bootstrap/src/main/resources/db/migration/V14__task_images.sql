-- 待办的图片附件（spec §4.1.3 / §5.5）。
--
-- 场景：日历页的「拍照」按钮拍一张纸质通知/白板，直接记成一条待办。
-- 图片本身走 /uploads/** 文件存储（§5.10），这里只存相对 URL 数组——
-- 与 feedback.images 同一套写法，避免「两处各存一种格式」。
--
-- 为什么先用 jsonb 数组而不是关联表：
--   图片只是待办的一个附属属性，没有独立查询需求（不像 event_recipient 要按成员/状态检索）。
--   真需要「按图片反查待办」时再拆表，现在拆只是提前复杂化。

ALTER TABLE task ADD COLUMN images JSONB NOT NULL DEFAULT '[]'::jsonb;
