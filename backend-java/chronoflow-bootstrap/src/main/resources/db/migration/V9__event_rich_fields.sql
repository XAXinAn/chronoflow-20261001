-- 日程字段扩充：对齐主流系统日历，并把地点改为结构化字段。见 spec §4.1.4 / §5.9。
--
-- 设计要点：
--   1) 旧列 location 是自由文本，这里重命名为 location_name，历史数据原样保留；
--      不回填 location_address——旧数据本来就没有地址信息。
--   2) 坐标统一存 GCJ-02（国内地图展示层坐标系）。保留 coordinate_system 列，
--      将来接海外服务（WGS-84）时不必做数据迁移。
--   3) availability / priority 给默认值，保证已有行满足 NOT NULL。

ALTER TABLE event RENAME COLUMN location TO location_name;

ALTER TABLE event
    ALTER COLUMN location_name TYPE VARCHAR(128),
    ADD COLUMN location_address    VARCHAR(255),
    ADD COLUMN latitude            NUMERIC(10, 7),
    ADD COLUMN longitude           NUMERIC(10, 7),
    ADD COLUMN poi_id              VARCHAR(64),
    ADD COLUMN coordinate_system   VARCHAR(16),
    ADD COLUMN availability        VARCHAR(16) NOT NULL DEFAULT 'BUSY',
    ADD COLUMN color               VARCHAR(16),
    ADD COLUMN priority            VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
    ADD COLUMN category            VARCHAR(64),
    ADD COLUMN url                 VARCHAR(512),
    ADD COLUMN travel_time_minutes INTEGER;

-- 状态枚举补 TENTATIVE（待定），与主流日历一致
ALTER TABLE event DROP CONSTRAINT ck_event_status;
ALTER TABLE event ADD CONSTRAINT ck_event_status
    CHECK (status IN ('CONFIRMED', 'TENTATIVE', 'CANCELLED'));

ALTER TABLE event
    ADD CONSTRAINT ck_event_availability CHECK (availability IN ('BUSY', 'FREE')),
    ADD CONSTRAINT ck_event_priority CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
    ADD CONSTRAINT ck_event_coordinate_system
        CHECK (coordinate_system IS NULL OR coordinate_system IN ('GCJ-02', 'WGS-84')),
    ADD CONSTRAINT ck_event_travel_time
        CHECK (travel_time_minutes IS NULL OR travel_time_minutes >= 0),
    -- 坐标必须成对出现，避免半个坐标点这种脏数据
    ADD CONSTRAINT ck_event_coordinate_pair CHECK (
        (latitude IS NULL AND longitude IS NULL)
        OR (latitude IS NOT NULL AND longitude IS NOT NULL AND coordinate_system IS NOT NULL)
    ),
    ADD CONSTRAINT ck_event_latitude CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
    ADD CONSTRAINT ck_event_longitude CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180));

-- 「这个地点还有哪些日程」依赖 poi_id
CREATE INDEX idx_event_poi ON event (poi_id) WHERE poi_id IS NOT NULL;
