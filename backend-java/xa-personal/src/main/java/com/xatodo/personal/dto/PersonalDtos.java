package com.xatodo.personal.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.time.LocalDate;
import java.time.OffsetDateTime;

/**
 * 个人日历 / 日程 / 待办的请求与响应体。
 */
public final class PersonalDtos {

    private PersonalDtos() {
    }

    /** 编辑范围：整条序列 / 仅本次 / 本次及以后（spec §6.2）。 */
    public enum EventScope {
        ALL, THIS, FUTURE
    }

    // ------------------------------------------------------------ calendar

    public record CalendarCreateRequest(
            @NotBlank(message = "日历名称不能为空")
            @Size(max = 64, message = "日历名称最长 64 个字符") String name,
            @Size(max = 16) String color,
            @Size(max = 64) String timezone,
            Boolean isDefault) {
    }

    public record CalendarUpdateRequest(
            @Size(max = 64) String name,
            @Size(max = 16) String color,
            @Size(max = 64) String timezone,
            Boolean isDefault) {
    }

    public record CalendarResponse(Long id,
                                   String calendarType,
                                   String name,
                                   String color,
                                   String timezone,
                                   Boolean isDefault) {
    }

    // --------------------------------------------------------------- event

    public record EventCreateRequest(
            Long calendarId,
            @NotBlank(message = "日程标题不能为空")
            @Size(max = 200, message = "标题最长 200 个字符") String title,
            String description,
            // 结构化地点（spec §5.9）。坐标由服务端统一按 GCJ-02 落库，
            // 客户端不得自行声明坐标系，因此这里不暴露 coordinateSystem。
            @Size(max = 128, message = "地点名称最长 128 个字符") String locationName,
            @Size(max = 255, message = "地点地址最长 255 个字符") String locationAddress,
            // 详细地址：地图定位不到的那一层（教室 / 门牌）由用户手填，与地点相互独立（spec §5.9）
            @Size(max = 255, message = "详细地址最长 255 个字符") String locationDetail,
            java.math.BigDecimal latitude,
            java.math.BigDecimal longitude,
            @Size(max = 64) String poiId,
            @NotNull(message = "开始时间不能为空") OffsetDateTime startAt,
            @NotNull(message = "结束时间不能为空") OffsetDateTime endAt,
            Boolean allDay,
            @Size(max = 64) String timezone,
            @Size(max = 512) String rrule,
            @Size(max = 16) String status,
            @Size(max = 16) String availability,
            @Size(max = 16) String color,
            @Size(max = 16) String priority,
            @Size(max = 64) String category,
            @Size(max = 512) String url,
            Integer travelTimeMinutes) {
    }

    public record EventUpdateRequest(
            @Size(max = 200) String title,
            String description,
            @Size(max = 128) String locationName,
            @Size(max = 255) String locationAddress,
            @Size(max = 255) String locationDetail,
            java.math.BigDecimal latitude,
            java.math.BigDecimal longitude,
            @Size(max = 64) String poiId,
            OffsetDateTime startAt,
            OffsetDateTime endAt,
            Boolean allDay,
            @Size(max = 64) String timezone,
            @Size(max = 512) String rrule,
            @Size(max = 16) String status,
            @Size(max = 16) String availability,
            @Size(max = 16) String color,
            @Size(max = 16) String priority,
            @Size(max = 64) String category,
            @Size(max = 512) String url,
            Integer travelTimeMinutes,
            EventScope scope,
            LocalDate occurrenceDate) {
    }

    public record EventResponse(Long id,
                                Long calendarId,
                                String title,
                                String description,
                                String locationName,
                                String locationAddress,
                                String locationDetail,
                                java.math.BigDecimal latitude,
                                java.math.BigDecimal longitude,
                                String poiId,
                                String coordinateSystem,
                                OffsetDateTime startAt,
                                OffsetDateTime endAt,
                                Boolean allDay,
                                String timezone,
                                String rrule,
                                String status,
                                String availability,
                                String color,
                                String priority,
                                String category,
                                String url,
                                Integer travelTimeMinutes) {

        /**
         * 实体 → 响应。字段多且有两处调用方（日程接口、待办转日程），
         * 映射集中在这里，避免两处各写一遍后逐渐漂移。
         */
        public static EventResponse from(com.xatodo.personal.entity.Event event) {
            return new EventResponse(
                    event.getId(), event.getCalendarId(), event.getTitle(), event.getDescription(),
                    event.getLocationName(), event.getLocationAddress(), event.getLocationDetail(),
                    event.getLatitude(), event.getLongitude(), event.getPoiId(), event.getCoordinateSystem(),
                    event.getStartAt(), event.getEndAt(), event.getAllDay(), event.getTimezone(),
                    event.getRrule(), event.getStatus(), event.getAvailability(), event.getColor(),
                    event.getPriority(), event.getCategory(), event.getUrl(), event.getTravelTimeMinutes());
        }
    }

    // ---------------------------------------------------------------- task

    public record TaskCreateRequest(
            Long calendarId,
            Long parentTaskId,
            /** 关联的日程 id，可空；为空表示不关联（spec §4.1.6） */
            Long eventId,
            @NotBlank(message = "待办标题不能为空")
            @Size(max = 200, message = "标题最长 200 个字符") String title,
            String description,
            OffsetDateTime dueAt,
            Boolean allDay,
            String priority,
            /** 图片附件的相对 URL 数组（§4.1.3）：日历页「拍照」直接带一张进来 */
            java.util.List<String> images,
            @Size(max = 512) String rrule) {
    }

    public record TaskUpdateRequest(
            @Size(max = 200) String title,
            String description,
            OffsetDateTime dueAt,
            /**
             * 显式清空截止时间（回到「待安排」）。
             *
             * <p>不能只靠 {@code dueAt = null} 表达：PATCH 语义里 null 是「不修改」，
             * 否则用户一旦设过截止时间就再也去不掉了。
             */
            Boolean clearDueAt,
            /** 关联/改绑日程；null 表示不修改 */
            Long eventId,
            /** 显式解除日程关联：null 在 PATCH 里是「不修改」，解绑必须靠这个开关 */
            Boolean clearEvent,
            Boolean allDay,
            String priority,
            String status,
            java.util.List<String> images,
            /**
             * 重复规则（RRULE）。null = 不修改；**空串 = 清空**（回到「不重复」）——
             * 与日程的 rrule 同一套语义，客户端不必再为「清空」发明第二个开关。
             */
            @Size(max = 512) String rrule,
            Integer sortOrder) {
    }

    public record TaskCompleteRequest(@NotNull(message = "completed 不能为空") Boolean completed) {
    }

    public record TaskResponse(Long id,
                               Long calendarId,
                               Long parentTaskId,
                               Long eventId,
                               /** 关联日程的标题，便于列表直接展示；未关联或日程已删则为 null */
                               String eventTitle,
                               String title,
                               String description,
                               OffsetDateTime dueAt,
                               Boolean allDay,
                               String status,
                               OffsetDateTime completedAt,
                               String priority,
                               java.util.List<String> images,
                               /** 重复规则（RRULE）：待办同样支持重复，如「每周五交周报」（spec §4.1.2） */
                               String rrule,
                               Integer sortOrder) {

        /**
         * 实体 → 响应。
         *
         * @param eventTitle 关联日程标题，由服务层批量查出来传入，避免逐条查库
         * @param images     图片相对 URL（jsonb 列由服务层解析后传入）
         */
        public static TaskResponse from(com.xatodo.personal.entity.Task task,
                                        String eventTitle,
                                        java.util.List<String> images) {
            return new TaskResponse(
                    task.getId(), task.getCalendarId(), task.getParentTaskId(),
                    task.getEventId(), eventTitle,
                    task.getTitle(), task.getDescription(), task.getDueAt(), task.getAllDay(),
                    task.getStatus(), task.getCompletedAt(), task.getPriority(), images,
                    task.getRrule(),
                    task.getSortOrder());
        }
    }

    /**
     * 待办转日程：需补齐起止时间；只给 startAt 时默认时长 1 小时（spec §4.1.1）。
     */
    public record TaskToEventRequest(OffsetDateTime startAt, OffsetDateTime endAt) {
    }
}
