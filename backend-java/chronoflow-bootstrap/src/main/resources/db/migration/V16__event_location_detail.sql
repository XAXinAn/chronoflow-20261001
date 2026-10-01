-- 地点与详细地址拆开（spec §5.9）：地图只能定位到「教学楼」，教室号要用户自己写。
-- 两者都可空：只选地点、只写详细地址、两者都不填，都合法。

ALTER TABLE event ADD COLUMN location_detail VARCHAR(255);
