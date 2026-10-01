package com.chronoflow.admin.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 平台超管后台的请求与响应体。
 */
public final class AdminDtos {

    private AdminDtos() {
    }

    public static final String PHONE_PATTERN = "^1[3-9]\\d{9}$";

    public record AdminLoginRequest(
            @NotBlank(message = "用户名不能为空") String username,
            @NotBlank(message = "密码不能为空") String password) {
    }

    public record AdminInfo(Long id, String username, String realName, String role, Long orgId, String status) {
    }

    public record AdminLoginResponse(String accessToken, long expiresIn, AdminInfo admin) {
    }

    public record AdminCreateRequest(
            @NotBlank(message = "用户名不能为空")
            @Size(min = 3, max = 64) String username,
            @NotBlank(message = "初始密码不能为空")
            @Size(min = 8, max = 64, message = "密码长度需在 8-64 之间") String password,
            @Size(max = 64) String realName,
            @Pattern(regexp = PHONE_PATTERN, message = "手机号格式不正确") String phone,
            @Size(max = 128) String email,
            @NotBlank(message = "角色不能为空") String role,
            Long orgId) {
    }

    public record AdminUpdateRequest(@Size(max = 64) String realName,
                                     @Size(max = 20) String phone,
                                     @Size(max = 128) String email,
                                     String status) {
    }

    public record ChangePasswordRequest(
            @NotBlank(message = "原密码不能为空") String oldPassword,
            @NotBlank(message = "新密码不能为空")
            @Size(min = 8, max = 64, message = "密码长度需在 8-64 之间") String newPassword) {
    }

    public record ResetPasswordRequest(
            @NotBlank(message = "新密码不能为空")
            @Size(min = 8, max = 64, message = "密码长度需在 8-64 之间") String newPassword) {
    }

    // ------------------------------------------------------------------ 组织

    public record OrganizationCreateRequest(
            @NotBlank(message = "组织名称不能为空") @Size(max = 128) String name,
            @NotBlank(message = "组织编码不能为空") @Size(max = 64) String code,
            @Size(max = 64) String timezone,
            Integer maxMembers,
            @NotBlank(message = "首位管理员用户名不能为空") @Size(min = 3, max = 64) String adminUsername,
            @NotBlank(message = "首位管理员密码不能为空")
            @Size(min = 8, max = 64, message = "密码长度需在 8-64 之间") String adminPassword,
            @Size(max = 64) String adminRealName,
            /**
             * 可选：预置的**首位拥有者**（成员唯一识别 ID，学号/工号）。
             *
             * <p>填了就同时建一个「总部」根部门与一条 OWNER 成员记录，组织一建好就能被认领；
             * 不填就是老行为（空组织，等组织管理员自己建部门、加人）。见 {@code OrgBootstrapService}。
             */
            @Size(max = 64) String ownerMemberKey,
            @Size(max = 64) String ownerRealName) {
    }

    public record OrganizationUpdateRequest(@Size(max = 128) String name,
                                            @Size(max = 512) String logoUrl,
                                            @Size(max = 64) String contactName,
                                            @Size(max = 20) String contactPhone,
                                            @Size(max = 64) String timezone,
                                            Integer maxMembers) {
    }

    public record OrganizationResponse(Long id,
                                       String name,
                                       String code,
                                       String logoUrl,
                                       String timezone,
                                       String status,
                                       Integer maxMembers,
                                       OffsetDateTime createdAt) {
    }

    public record OrganizationStatusRequest(@NotBlank(message = "状态不能为空") String status) {
    }

    // ------------------------------------------------------------------ 账号

    public record AccountIdentityResponse(Long identityId,
                                          String identityType,
                                          Long orgId,
                                          String orgName,
                                          String nickname,
                                          String status) {
    }

    public record AccountResponse(Long accountId,
                                  String phone,
                                  String email,
                                  String wechatBound,
                                  String status,
                                  OffsetDateTime lastLoginAt,
                                  OffsetDateTime createdAt,
                                  List<AccountIdentityResponse> identities) {
    }

    public record AccountStatusRequest(@NotBlank(message = "状态不能为空") String status) {
    }

    // -------------------------------------------------------------- 全局配置

    public record SystemConfigResponse(String configKey,
                                       String configValue,
                                       String description,
                                       OffsetDateTime updatedAt) {
    }

    public record SystemConfigUpdateRequest(@NotBlank(message = "配置值不能为空") String configValue,
                                            @Size(max = 255) String description) {
    }

    // ------------------------------------------------------------------ 看板

    public record DashboardResponse(long organizationCount,
                                    long activeOrganizationCount,
                                    long accountCount,
                                    long disabledAccountCount,
                                    long orgMemberCount,
                                    long personalEventCount,
                                    long taskCount,
                                    long completedTaskCount,
                                    long dispatchCount) {
    }

    // ------------------------------------------------------------------ 审计

    public record AuditLogResponse(Long id,
                                   String actorType,
                                   String actorName,
                                   Long orgId,
                                   String action,
                                   String targetType,
                                   Long targetId,
                                   String detail,
                                   String ip,
                                   OffsetDateTime createdAt) {
    }
}
