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
            @Size(max = 255) String location,
            @NotNull(message = "开始时间不能为空") OffsetDateTime startAt,
            @NotNull(message = "结束时间不能为空") OffsetDateTime endAt,
            Boolean allDay,
            @Size(max = 64) String timezone,
            @Size(max = 512) String rrule) {
    }

    public record EventUpdateRequest(
            @Size(max = 200) String title,
            String description,
            @Size(max = 255) String location,
            OffsetDateTime startAt,
            OffsetDateTime endAt,
            Boolean allDay,
            @Size(max = 64) String timezone,
            @Size(max = 512) String rrule,
            EventScope scope,
            LocalDate occurrenceDate) {
    }

    public record EventResponse(Long id,
                                Long calendarId,
                                String title,
                                String description,
                                String location,
                                OffsetDateTime startAt,
                                OffsetDateTime endAt,
                                Boolean allDay,
                                String timezone,
                                String rrule,
                                String status) {
    }

    // ---------------------------------------------------------------- task

    public record TaskCreateRequest(
            Long calendarId,
            Long parentTaskId,
            @NotBlank(message = "待办标题不能为空")
            @Size(max = 200, message = "标题最长 200 个字符") String title,
            String description,
            OffsetDateTime dueAt,
            Boolean allDay,
            String priority,
            @Size(max = 512) String rrule) {
    }

    public record TaskUpdateRequest(
            @Size(max = 200) String title,
            String description,
            OffsetDateTime dueAt,
            Boolean allDay,
            String priority,
            String status,
            Integer sortOrder) {
    }

    public record TaskCompleteRequest(@NotNull(message = "completed 不能为空") Boolean completed) {
    }

    public record TaskResponse(Long id,
                               Long calendarId,
                               Long parentTaskId,
                               String title,
                               String description,
                               OffsetDateTime dueAt,
                               Boolean allDay,
                               String status,
                               OffsetDateTime completedAt,
                               String priority,
                               Integer sortOrder) {
    }
}
