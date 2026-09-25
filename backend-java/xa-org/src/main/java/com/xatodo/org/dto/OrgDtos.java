package com.xatodo.org.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Set;

/**
 * 组织模块的请求与响应体。
 */
public final class OrgDtos {

    private OrgDtos() {
    }

    public static final String PHONE_PATTERN = "^1[3-9]\\d{9}$";

    // --------------------------------------------------------------- 组织上下文

    public record OrgCurrentResponse(Long orgId,
                                     String orgName,
                                     String orgCode,
                                     String orgLogoUrl,
                                     String orgTimezone,
                                     Long memberId,
                                     String realName,
                                     String memberNo,
                                     String jobTitle,
                                     String orgRole,
                                     Long departmentId,
                                     String departmentName,
                                     List<String> departmentPathNames,
                                     boolean orgAdmin,
                                     Set<Long> manageableDepartmentIds) {
    }

    // ------------------------------------------------------------------ 部门

    public record DepartmentNode(Long id,
                                 Long parentId,
                                 String name,
                                 Short level,
                                 String path,
                                 Integer sortOrder,
                                 List<DepartmentNode> children) {
    }

    public record DepartmentCreateRequest(Long parentId,
                                          @NotBlank(message = "部门名称不能为空")
                                          @Size(max = 64, message = "部门名称最长 64 个字符") String name,
                                          Integer sortOrder) {
    }

    public record DepartmentUpdateRequest(@Size(max = 64) String name,
                                          Integer sortOrder) {
    }

    public record DeptManagerGrantRequest(@NotNull(message = "orgMemberId 不能为空") Long orgMemberId) {
    }

    // ------------------------------------------------------------------ 成员

    public record OrgMemberResponse(Long id,
                                    Long identityId,
                                    Long departmentId,
                                    String departmentName,
                                    String realName,
                                    String memberNo,
                                    String jobTitle,
                                    String orgRole,
                                    String status,
                                    boolean departmentManager) {
    }

    public record OrgMemberCreateRequest(
            @NotBlank(message = "手机号不能为空")
            @Pattern(regexp = PHONE_PATTERN, message = "手机号格式不正确") String phone,
            @NotBlank(message = "姓名不能为空")
            @Size(max = 64) String realName,
            @NotNull(message = "departmentId 不能为空") Long departmentId,
            @Size(max = 64) String memberNo,
            @Size(max = 64) String jobTitle,
            String orgRole) {
    }

    public record OrgMemberUpdateRequest(@Size(max = 64) String realName,
                                         Long departmentId,
                                         @Size(max = 64) String memberNo,
                                         @Size(max = 64) String jobTitle,
                                         String orgRole,
                                         String status) {
    }

    // -------------------------------------------------------------- 组织日程

    public record OrgEventDispatchRequest(
            @NotBlank(message = "日程标题不能为空")
            @Size(max = 200) String title,
            String description,
            @Size(max = 255) String location,
            @NotNull(message = "开始时间不能为空") OffsetDateTime startAt,
            @NotNull(message = "结束时间不能为空") OffsetDateTime endAt,
            Boolean allDay,
            @Size(max = 64) String timezone,
            @Size(max = 512) String rrule,
            @NotBlank(message = "下发范围不能为空") String scopeType,
            Long departmentId,
            Boolean includeSubDepartments,
            List<Long> memberIds,
            Boolean requireReceipt) {
    }

    public record OrgEventResponse(Long eventId,
                                   Long dispatchId,
                                   String title,
                                   String description,
                                   String location,
                                   OffsetDateTime startAt,
                                   OffsetDateTime endAt,
                                   Boolean allDay,
                                   String timezone,
                                   String rrule,
                                   Boolean requireReceipt,
                                   String receiptStatus,
                                   OffsetDateTime receiptAt,
                                   String remark,
                                   boolean read) {
    }

    public record ReceiptRequest(
            @NotBlank(message = "回执状态不能为空") String status,
            @Size(max = 512) String remark,
            LocalDate occurrenceDate) {
    }

    public record ReceiptItem(Long orgMemberId,
                              String realName,
                              String departmentName,
                              String receiptStatus,
                              OffsetDateTime receiptAt,
                              String remark,
                              boolean read) {
    }

    public record ReceiptSummaryResponse(Long dispatchId,
                                         Long eventId,
                                         String scopeType,
                                         boolean requireReceipt,
                                         int total,
                                         int pending,
                                         int accepted,
                                         int declined,
                                         int completed,
                                         int readCount,
                                         List<ReceiptItem> items) {
    }
}
