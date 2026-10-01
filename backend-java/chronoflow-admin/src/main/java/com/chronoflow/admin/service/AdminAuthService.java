package com.chronoflow.admin.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.chronoflow.admin.dto.AdminDtos.AdminCreateRequest;
import com.chronoflow.admin.dto.AdminDtos.AdminInfo;
import com.chronoflow.admin.dto.AdminDtos.AdminLoginRequest;
import com.chronoflow.admin.dto.AdminDtos.AdminLoginResponse;
import com.chronoflow.admin.dto.AdminDtos.AdminUpdateRequest;
import com.chronoflow.admin.dto.AdminDtos.ChangePasswordRequest;
import com.chronoflow.admin.dto.AdminDtos.ResetPasswordRequest;
import com.chronoflow.admin.entity.AdminUser;
import com.chronoflow.admin.mapper.AdminUserMapper;
import com.chronoflow.admin.security.AdminPrincipal;
import com.chronoflow.admin.security.AdminTokenService;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;

/**
 * 后台管理员认证与管理（spec §3.4）。
 *
 * <p>独立账号密码体系：用户名 + BCrypt 密码；连续失败 5 次锁定 15 分钟并记录登录日志。
 */
@Service
public class AdminAuthService {

    private static final int MAX_FAILED_ATTEMPTS = 5;
    private static final int LOCK_MINUTES = 15;
    private static final Map<String, String> LOGIN_TYPE = Map.of("type", "PASSWORD");

    private final AdminUserMapper adminUserMapper;
    private final AdminTokenService adminTokenService;
    private final PasswordEncoder passwordEncoder;
    private final AuditLogService auditLogService;
    private final JdbcTemplate jdbcTemplate;

    public AdminAuthService(AdminUserMapper adminUserMapper,
                            AdminTokenService adminTokenService,
                            PasswordEncoder passwordEncoder,
                            AuditLogService auditLogService,
                            JdbcTemplate jdbcTemplate) {
        this.adminUserMapper = adminUserMapper;
        this.adminTokenService = adminTokenService;
        this.passwordEncoder = passwordEncoder;
        this.auditLogService = auditLogService;
        this.jdbcTemplate = jdbcTemplate;
    }

    /**
     * 刻意**不加** {@code @Transactional}：失败分支最后会抛出业务异常，
     * 若处于事务中，刚写入的失败计数与锁定时间会被一并回滚，导致锁定永不生效。
     * 登录流程本身也不需要原子性。
     */
    public AdminLoginResponse login(AdminLoginRequest request, String ip, String userAgent) {
        AdminUser admin = adminUserMapper.selectOne(new LambdaQueryWrapper<AdminUser>()
                .eq(AdminUser::getUsername, request.username()));
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);

        if (admin == null) {
            recordLogin(null, "FAIL", "用户名不存在", ip, userAgent);
            throw BizException.of(ErrorCode.ADMIN_LOGIN_FAILED);
        }
        if (admin.getLockedUntil() != null && admin.getLockedUntil().isAfter(now)) {
            recordLogin(admin.getId(), "FAIL", "账号已锁定", ip, userAgent);
            throw BizException.of(ErrorCode.ADMIN_LOGIN_FAILED, "账号已锁定，请稍后再试");
        }
        if (AdminUser.STATUS_DISABLED.equals(admin.getStatus())) {
            recordLogin(admin.getId(), "FAIL", "账号已停用", ip, userAgent);
            throw BizException.of(ErrorCode.ADMIN_LOGIN_FAILED, "账号已停用");
        }
        if (!passwordEncoder.matches(request.password(), admin.getPasswordHash())) {
            int failures = (admin.getFailedLoginCount() == null ? 0 : admin.getFailedLoginCount()) + 1;
            admin.setFailedLoginCount(failures);
            if (failures >= MAX_FAILED_ATTEMPTS) {
                admin.setLockedUntil(now.plusMinutes(LOCK_MINUTES));
            }
            adminUserMapper.updateById(admin);
            recordLogin(admin.getId(), "FAIL", "密码错误", ip, userAgent);
            throw BizException.of(ErrorCode.ADMIN_LOGIN_FAILED);
        }

        admin.setFailedLoginCount(0);
        admin.setLockedUntil(null);
        admin.setLastLoginAt(now);
        adminUserMapper.updateById(admin);
        recordLogin(admin.getId(), "SUCCESS", null, ip, userAgent);

        AdminPrincipal principal = new AdminPrincipal(
                admin.getId(), admin.getUsername(), admin.getRole(), admin.getOrgId());
        auditLogService.record(principal, "ADMIN_LOGIN", "ADMIN_USER", admin.getId(), null);
        return new AdminLoginResponse(adminTokenService.issue(admin), adminTokenService.ttlSeconds(),
                toInfo(admin));
    }

    public AdminInfo me(AdminPrincipal principal) {
        return toInfo(requireAdmin(principal.adminId()));
    }

    @Transactional
    public void changePassword(AdminPrincipal principal, ChangePasswordRequest request) {
        AdminUser admin = requireAdmin(principal.adminId());
        if (!passwordEncoder.matches(request.oldPassword(), admin.getPasswordHash())) {
            throw BizException.of(ErrorCode.ADMIN_LOGIN_FAILED, "原密码不正确");
        }
        admin.setPasswordHash(passwordEncoder.encode(request.newPassword()));
        adminUserMapper.updateById(admin);
        auditLogService.record(principal, "ADMIN_CHANGE_PASSWORD", "ADMIN_USER", admin.getId(), null);
    }

    public List<AdminInfo> list(AdminPrincipal principal) {
        LambdaQueryWrapper<AdminUser> query = new LambdaQueryWrapper<AdminUser>()
                .orderByAsc(AdminUser::getId);
        if (!principal.isSuperAdmin()) {
            query.eq(AdminUser::getOrgId, principal.orgId());
        }
        return adminUserMapper.selectList(query).stream().map(this::toInfo).toList();
    }

    /**
     * 创建后台管理员。仅超管可创建；组织管理员必须绑定组织。
     */
    @Transactional
    public AdminInfo create(AdminPrincipal principal, AdminCreateRequest request) {
        if (!principal.isSuperAdmin()) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该操作需要平台超管权限");
        }
        if (!AdminUser.ROLE_SUPER_ADMIN.equals(request.role())
                && !AdminUser.ROLE_ORG_ADMIN.equals(request.role())) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "角色取值非法: " + request.role());
        }
        if (AdminUser.ROLE_ORG_ADMIN.equals(request.role()) && request.orgId() == null) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "组织管理员必须绑定组织");
        }
        Long existing = adminUserMapper.selectCount(new LambdaQueryWrapper<AdminUser>()
                .eq(AdminUser::getUsername, request.username()));
        if (existing != null && existing > 0) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "用户名已存在");
        }

        AdminUser admin = new AdminUser();
        admin.setUsername(request.username());
        admin.setPasswordHash(passwordEncoder.encode(request.password()));
        admin.setRealName(request.realName());
        admin.setPhone(request.phone());
        admin.setEmail(request.email());
        admin.setRole(request.role());
        admin.setOrgId(AdminUser.ROLE_ORG_ADMIN.equals(request.role()) ? request.orgId() : null);
        admin.setMfaEnabled(false);
        admin.setStatus(AdminUser.STATUS_ACTIVE);
        admin.setFailedLoginCount(0);
        adminUserMapper.insert(admin);

        auditLogService.record(principal, "ADMIN_CREATE", "ADMIN_USER", admin.getId(),
                Map.of("username", admin.getUsername(), "role", admin.getRole()));
        return toInfo(admin);
    }

    @Transactional
    public AdminInfo update(AdminPrincipal principal, Long adminId, AdminUpdateRequest request) {
        if (!principal.isSuperAdmin()) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该操作需要平台超管权限");
        }
        AdminUser admin = requireAdmin(adminId);
        if (admin.getId().equals(principal.adminId())
                && AdminUser.STATUS_DISABLED.equals(request.status())) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "不能停用当前登录的管理员账号");
        }
        if (StringUtils.hasText(request.realName())) {
            admin.setRealName(request.realName());
        }
        if (request.phone() != null) {
            admin.setPhone(request.phone());
        }
        if (request.email() != null) {
            admin.setEmail(request.email());
        }
        if (StringUtils.hasText(request.status())) {
            if (!AdminUser.STATUS_ACTIVE.equals(request.status())
                    && !AdminUser.STATUS_DISABLED.equals(request.status())) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "状态取值非法: " + request.status());
            }
            admin.setStatus(request.status());
        }
        adminUserMapper.updateById(admin);
        auditLogService.record(principal, "ADMIN_UPDATE", "ADMIN_USER", admin.getId(),
                Map.of("status", String.valueOf(admin.getStatus())));
        return toInfo(admin);
    }

    @Transactional
    public void resetPassword(AdminPrincipal principal, Long adminId, ResetPasswordRequest request) {
        if (!principal.isSuperAdmin()) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该操作需要平台超管权限");
        }
        AdminUser admin = requireAdmin(adminId);
        admin.setPasswordHash(passwordEncoder.encode(request.newPassword()));
        admin.setFailedLoginCount(0);
        admin.setLockedUntil(null);
        adminUserMapper.updateById(admin);
        auditLogService.record(principal, "ADMIN_RESET_PASSWORD", "ADMIN_USER", admin.getId(), null);
    }

    public AdminUser requireAdmin(Long adminId) {
        AdminUser admin = adminUserMapper.selectById(adminId);
        if (admin == null) {
            throw BizException.of(ErrorCode.UNAUTHENTICATED);
        }
        return admin;
    }

    private void recordLogin(Long adminId, String result, String failReason, String ip, String userAgent) {
        try {
            jdbcTemplate.update(
                    "INSERT INTO login_log (principal_type, admin_user_id, login_type, result, "
                            + "fail_reason, ip, user_agent) VALUES ('ADMIN', ?, 'PASSWORD', ?, ?, ?, ?)",
                    adminId, result, failReason, ip, userAgent);
        } catch (Exception ignored) {
            // 登录日志写入失败不影响登录流程
        }
    }

    private AdminInfo toInfo(AdminUser admin) {
        return new AdminInfo(admin.getId(), admin.getUsername(), admin.getRealName(),
                admin.getRole(), admin.getOrgId(), admin.getStatus());
    }
}
