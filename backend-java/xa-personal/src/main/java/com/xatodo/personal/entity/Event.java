package com.xatodo.personal.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;

import java.math.BigDecimal;
import java.time.OffsetDateTime;

/**
 * 日程：占用时间段的日历事件，可携带 RRULE 重复规则（spec §5.5）。
 */
@TableName("event")
public class Event {

    public static final String STATUS_CONFIRMED = "CONFIRMED";
    public static final String STATUS_TENTATIVE = "TENTATIVE";
    public static final String STATUS_CANCELLED = "CANCELLED";
    public static final String SOURCE_PERSONAL = "PERSONAL";
    public static final String AVAILABILITY_BUSY = "BUSY";
    public static final String AVAILABILITY_FREE = "FREE";
    public static final String PRIORITY_NORMAL = "NORMAL";
    /** 国内地图展示层统一使用 GCJ-02，落库坐标一律用它（spec §5.9）。 */
    public static final String COORDINATE_GCJ02 = "GCJ-02";

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long calendarId;

    private Long orgId;

    private Long creatorIdentityId;

    private String sourceType;

    private String title;

    private String description;

    // ---------------------------------------------------------------- 地点
    // 地点不再是一个自由文本字段，拆成结构化信息以便导航与按地点归并（spec §5.9）
    /*
     * 这一组字段必须允许写入 null：MyBatis-Plus 的 updateById 默认忽略 null 字段，
     * 「清空地点」会变成一次静默失败——接口返回看着是清空了，库里其实没动。
     * 更新流程是「先读出完整实体、改完再写回」，所以全量写回不会误伤其他字段。
     */
    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private String locationName;

    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private String locationAddress;

    /** 详细地址：地图只能定位到「教学楼」时用户手填的补充（如「3 号楼 305」），可空（spec §5.9）。 */
    private String locationDetail;

    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private BigDecimal latitude;

    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private BigDecimal longitude;

    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private String poiId;

    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private String coordinateSystem;

    // ------------------------------------------------------------ 日程属性
    /** 忙碌状态：BUSY / FREE，供合并视图判断是否占用时段 */
    private String availability;

    /** 覆盖所属日历颜色，为空时跟随日历 */
    private String color;

    private String priority;

    private String category;

    private String url;

    /** 出行时间（分钟），用于出发提醒 */
    private Integer travelTimeMinutes;

    private OffsetDateTime at;


    private String timezone;

    private String rrule;

    private OffsetDateTime rruleUntil;

    private String status;

    private Long dispatchId;

    private Boolean updatedAfterDispatch;

    private OffsetDateTime createdAt;

    private OffsetDateTime updatedAt;

    private OffsetDateTime deletedAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getCalendarId() {
        return calendarId;
    }

    public void setCalendarId(Long calendarId) {
        this.calendarId = calendarId;
    }

    public Long getOrgId() {
        return orgId;
    }

    public void setOrgId(Long orgId) {
        this.orgId = orgId;
    }

    public Long getCreatorIdentityId() {
        return creatorIdentityId;
    }

    public void setCreatorIdentityId(Long creatorIdentityId) {
        this.creatorIdentityId = creatorIdentityId;
    }

    public String getSourceType() {
        return sourceType;
    }

    public void setSourceType(String sourceType) {
        this.sourceType = sourceType;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public String getLocationName() {
        return locationName;
    }

    public void setLocationName(String locationName) {
        this.locationName = locationName;
    }

    public String getLocationAddress() {
        return locationAddress;
    }

    public String getLocationDetail() {
        return locationDetail;
    }

    public void setLocationDetail(String locationDetail) {
        this.locationDetail = locationDetail;
    }

    public void setLocationAddress(String locationAddress) {
        this.locationAddress = locationAddress;
    }

    public BigDecimal getLatitude() {
        return latitude;
    }

    public void setLatitude(BigDecimal latitude) {
        this.latitude = latitude;
    }

    public BigDecimal getLongitude() {
        return longitude;
    }

    public void setLongitude(BigDecimal longitude) {
        this.longitude = longitude;
    }

    public String getPoiId() {
        return poiId;
    }

    public void setPoiId(String poiId) {
        this.poiId = poiId;
    }

    public String getCoordinateSystem() {
        return coordinateSystem;
    }

    public void setCoordinateSystem(String coordinateSystem) {
        this.coordinateSystem = coordinateSystem;
    }

    public String getAvailability() {
        return availability;
    }

    public void setAvailability(String availability) {
        this.availability = availability;
    }

    public String getColor() {
        return color;
    }

    public void setColor(String color) {
        this.color = color;
    }

    public String getPriority() {
        return priority;
    }

    public void setPriority(String priority) {
        this.priority = priority;
    }

    public String getCategory() {
        return category;
    }

    public void setCategory(String category) {
        this.category = category;
    }

    public String getUrl() {
        return url;
    }

    public void setUrl(String url) {
        this.url = url;
    }

    public Integer getTravelTimeMinutes() {
        return travelTimeMinutes;
    }

    public void setTravelTimeMinutes(Integer travelTimeMinutes) {
        this.travelTimeMinutes = travelTimeMinutes;
    }

    public OffsetDateTime getAt() {
        return at;
    }

    public void setAt(OffsetDateTime at) {
        this.at = at;
    }

    public String getTimezone() {
        return timezone;
    }

    public void setTimezone(String timezone) {
        this.timezone = timezone;
    }

    public String getRrule() {
        return rrule;
    }

    public void setRrule(String rrule) {
        this.rrule = rrule;
    }

    public OffsetDateTime getRruleUntil() {
        return rruleUntil;
    }

    public void setRruleUntil(OffsetDateTime rruleUntil) {
        this.rruleUntil = rruleUntil;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public Long getDispatchId() {
        return dispatchId;
    }

    public void setDispatchId(Long dispatchId) {
        this.dispatchId = dispatchId;
    }

    public Boolean getUpdatedAfterDispatch() {
        return updatedAfterDispatch;
    }

    public void setUpdatedAfterDispatch(Boolean updatedAfterDispatch) {
        this.updatedAfterDispatch = updatedAfterDispatch;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(OffsetDateTime createdAt) {
        this.createdAt = createdAt;
    }

    public OffsetDateTime getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(OffsetDateTime updatedAt) {
        this.updatedAt = updatedAt;
    }

    public OffsetDateTime getDeletedAt() {
        return deletedAt;
    }

    public void setDeletedAt(OffsetDateTime deletedAt) {
        this.deletedAt = deletedAt;
    }
}
