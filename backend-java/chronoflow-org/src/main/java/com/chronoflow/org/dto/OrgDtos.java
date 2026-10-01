package com.chronoflow.org.dto;

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
                                     String memberKey,
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
                                    /** 是否已被某个个人账号认领（认领后才有组织身份） */
                                    boolean bound,
                                    Long departmentId,
                                    String departmentName,
                                    String realName,
                                    String memberKey,
                                    String jobTitle,
                                    String orgRole,
                                    String status,
                                    boolean departmentManager) {
    }

    /**
     * 新增成员：**只需要成员唯一识别 ID**（spec §3.1）。
     *
     * <p>手机号/邮箱是选填的联系方式，不参与登录；组织账号靠「组织唯一 ID + 唯一识别 ID」认领。
     */
    public record OrgMemberCreateRequest(
            @NotBlank(message = "成员唯一识别 ID 不能为空")
            @Size(max = 64, message = "成员唯一识别 ID 最长 64 个字符") String memberKey,
            @NotBlank(message = "姓名不能为空")
            @Size(max = 64) String realName,
            @NotNull(message = "departmentId 不能为空") Long departmentId,
            @Pattern(regexp = PHONE_PATTERN, message = "手机号格式不正确") String phone,
            @Size(max = 64) String jobTitle,
            String orgRole) {
    }

    public record OrgMemberUpdateRequest(@Size(max = 64) String realName,
                                         Long departmentId,
                                         @Size(max = 64) String memberKey,
                                         @Size(max = 64) String jobTitle,
                                         String orgRole,
                                         String status) {
    }

    // ------------------------------------------------------------ 组织账号

    /**
     * 登录组织账号并绑定（spec §3.2）。
     *
     * @param org 组织唯一 ID：组织编码（如 XATECH）或数字 ID 均可
     * @param memberKey 成员唯一识别 ID（学号/工号）
     */
    public record OrgAccountLinkRequest(
            @NotBlank(message = "组织唯一 ID 不能为空") String org,
            @NotBlank(message = "成员唯一识别 ID 不能为空") String memberKey) {
    }

    /**
     * 已绑定的组织账号。
     *
     * @param lastLoginAt 最近一次登录这个组织账号的时间
     */
    public record OrgAccountResponse(Long identityId,
                                     Long orgId,
                                     String orgName,
                                     String orgCode,
                                     String memberKey,
                                     String realName,
                                     String departmentName,
                                     String orgRole,
                                     OffsetDateTime lastLoginAt) {
    }

    // -------------------------------------------------------------- 组织日程

    public record OrgEventDispatchRequest(
            @NotBlank(message = "日程标题不能为空")
            @Size(max = 200) String title,
            String description,
            @Size(max = 255) String location,
            /** 详细地址：地图只能定位到楼，教室/门牌由用户手填，与地点都可空（spec §5.9） */
            @Size(max = 255) String locationDetail,
            // 单时间点：只说了哪天的给当天 00:00（spec §4.1.2）
            @NotNull(message = "日程时间不能为空") OffsetDateTime at,
            @Size(max = 64) String timezone,
            @Size(max = 512) String rrule,
            @NotBlank(message = "下发范围不能为空") String scopeType,
            Long departmentId,
            Boolean includeSubDepartments,
            List<Long> memberIds) {
    }

    /**
     * 成员端与发起人看到的组织日程。
     *
     * <p>首版**不收集回执**（spec §4.2.2）：所以这里没有回执状态字段，
     * 卡片与个人日程长得一样，差别只有 `canEdit`（只有发起人为 true）。
     */
    public record OrgEventResponse(Long eventId,
                                   Long dispatchId,
                                   String title,
                                   String description,
                                   String location,
                                   String locationDetail,
                                   OffsetDateTime at,
                                   String timezone,
                                   String rrule,
                                   boolean read,
                                   /**
                                    * 当前身份能不能改这条组织日程（发起人 / 组织管理员 / 被授权部门的管理者）。
                                    *
                                    * <p>由服务端判定：App 里「编辑」入口显不显示靠它，而不是靠前端猜权限。
                                    */
                                   boolean canEdit) {
    }

    // -------------------------------------------------------------- 成员导入

    /**
     * 导入的一行。
     *
     * @param memberKey 成员唯一识别 ID（学号/工号），必填——它就是组织账号的登录凭据
     */
    public record ImportRow(Integer rowNo,
                            String realName,
                            String memberKey,
                            String departmentPath,
                            String role) {
    }

    public record ImportBatchResponse(Long batchId,
                                      String fileName,
                                      String status,
                                      int totalCount,
                                      int successCount,
                                      int failCount,
                                      OffsetDateTime createdAt,
                                      OffsetDateTime finishedAt,
                                      List<ImportRowResponse> rows) {
    }

    public record ImportRowResponse(Integer rowNo,
                                    String status,
                                    String errorMessage,
                                    Long createdMemberId,
                                    String rawData) {
    }

    public record OrgEventUpdateRequest(@Size(max = 200) String title,
                                        String description,
                                        @Size(max = 255) String location,
                                        @Size(max = 255) String locationDetail,
                                        OffsetDateTime at,
                                        @Size(max = 64) String timezone,
                                        Boolean redispatch) {
    }

    /**
     * 组织管理端（Web）的组织日程条目：比成员侧多出下发范围与回执统计（spec §4.3 组织日历管理）。
     *
     * <p>撤回的下发默认不出现在列表里（与成员端展示口径一致）；带 {@code includeRevoked} 查历史时
     * 会一起返回，靠 {@link #status()} 区分。
     */
    public record OrgEventManageItem(Long eventId,
                                     Long dispatchId,
                                     String title,
                                     String description,
                                     String location,
                                     String locationDetail,
                                     OffsetDateTime at,
                                     String timezone,
                                     String scopeType,
                                     Long departmentId,
                                     int recipientCount,
                                     /**
                                      * 下发状态：`ACTIVE`（生效中）/ `REVOKED`（已撤回，仅历史视图可见）。
                                      */
                                     String status,
                                     /**
                                      * 当前身份能不能改 / 撤 / 删这条。
                                      *
                                      * <p>与成员侧 {@link OrgEventResponse#canEdit()} 同一条规则：只有**发起人本人**为
                                      * true（组织管理员也不行，spec §4.2.2）。页面据此决定「撤回 / 删除」显不显示，
                                      * 而不是点下去再收 20003。
                                      */
                                     boolean canEdit) {
    }

    // -------------------------------------------------------------- 组织设置

    /**
     * 组织设置（spec §4.3）。成员上限只读——上限由平台超管在 §4.4 控制，组织侧不能自行上调。
     */
    public record OrgSettingsResponse(Long orgId,
                                      String name,
                                      String code,
                                      String logoUrl,
                                      String contactName,
                                      String contactPhone,
                                      String timezone,
                                      String status,
                                      Integer maxMembers,
                                      long memberCount) {
    }

    public record OrgSettingsUpdateRequest(@Size(max = 128) String name,
                                           @Size(max = 512) String logoUrl,
                                           @Size(max = 64) String contactName,
                                           @Size(max = 20) String contactPhone,
                                           @Size(max = 64) String timezone) {
    }
}
