package com.xatodo.admin.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.admin.dto.AdminDtos.OrganizationCreateRequest;
import com.xatodo.admin.dto.AdminDtos.OrganizationResponse;
import com.xatodo.admin.dto.AdminDtos.OrganizationUpdateRequest;
import com.xatodo.admin.entity.AdminUser;
import com.xatodo.admin.mapper.AdminUserMapper;
import com.xatodo.admin.security.AdminPrincipal;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.org.entity.Organization;
import com.xatodo.org.mapper.OrganizationMapper;
import com.xatodo.org.service.OrgBootstrapService;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 组织（租户）管理。创建组织时同步创建首位组织管理员（spec §4.4）。
 */
@Service
public class AdminOrganizationService {

    private static final Set<String> STATUSES =
            Set.of(Organization.STATUS_ACTIVE, Organization.STATUS_SUSPENDED, Organization.STATUS_DISABLED);

    private final OrganizationMapper organizationMapper;
    private final AdminUserMapper adminUserMapper;
    private final PasswordEncoder passwordEncoder;
    private final AuditLogService auditLogService;
    private final OrgBootstrapService orgBootstrapService;

    public AdminOrganizationService(OrganizationMapper organizationMapper,
                                    AdminUserMapper adminUserMapper,
                                    PasswordEncoder passwordEncoder,
                                    AuditLogService auditLogService,
                                    OrgBootstrapService orgBootstrapService) {
        this.organizationMapper = organizationMapper;
        this.adminUserMapper = adminUserMapper;
        this.passwordEncoder = passwordEncoder;
        this.auditLogService = auditLogService;
        this.orgBootstrapService = orgBootstrapService;
    }

    @Transactional
    public OrganizationResponse create(AdminPrincipal principal, OrganizationCreateRequest request) {
        Long duplicated = organizationMapper.selectCount(new LambdaQueryWrapper<Organization>()
                .eq(Organization::getCode, request.code()));
        if (duplicated != null && duplicated > 0) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "组织编码已存在");
        }
        Long adminDuplicated = adminUserMapper.selectCount(new LambdaQueryWrapper<AdminUser>()
                .eq(AdminUser::getUsername, request.adminUsername()));
        if (adminDuplicated != null && adminDuplicated > 0) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "管理员用户名已存在");
        }

        Organization organization = new Organization();
        organization.setName(request.name());
        organization.setCode(request.code());
        organization.setTimezone(StringUtils.hasText(request.timezone()) ? request.timezone() : "Asia/Shanghai");
        organization.setMaxMembers(request.maxMembers() == null ? 100 : request.maxMembers());
        organization.setStatus(Organization.STATUS_ACTIVE);
        organizationMapper.insert(organization);

        AdminUser orgAdmin = new AdminUser();
        orgAdmin.setUsername(request.adminUsername());
        orgAdmin.setPasswordHash(passwordEncoder.encode(request.adminPassword()));
        orgAdmin.setRealName(StringUtils.hasText(request.adminRealName())
                ? request.adminRealName() : request.adminUsername());
        orgAdmin.setRole(AdminUser.ROLE_ORG_ADMIN);
        orgAdmin.setOrgId(organization.getId());
        orgAdmin.setMfaEnabled(false);
        orgAdmin.setStatus(AdminUser.STATUS_ACTIVE);
        orgAdmin.setFailedLoginCount(0);
        adminUserMapper.insert(orgAdmin);

        organization.setCreatedByAdminId(principal.adminId());
        organizationMapper.updateById(organization);

        // 可选：预置「首位拥有者」。不填就维持老行为（空组织），填了组织一建好就能被认领（spec §3.4）
        if (StringUtils.hasText(request.ownerMemberKey())) {
            orgBootstrapService.createRootOwner(organization.getId(),
                    request.ownerMemberKey(), request.ownerRealName());
        }

        auditLogService.record(principal, "ORG_CREATE", "ORGANIZATION", organization.getId(),
                Map.of("code", organization.getCode(), "adminUsername", orgAdmin.getUsername()));
        return toResponse(organization);
    }

    public List<OrganizationResponse> list(AdminPrincipal principal) {
        return organizationMapper.selectList(new LambdaQueryWrapper<Organization>()
                        .isNull(Organization::getDeletedAt)
                        .orderByDesc(Organization::getId))
                .stream().map(this::toResponse).toList();
    }

    public OrganizationResponse get(AdminPrincipal principal, Long orgId) {
        return toResponse(requireOrg(orgId));
    }

    @Transactional
    public OrganizationResponse update(AdminPrincipal principal, Long orgId, OrganizationUpdateRequest request) {
        Organization organization = requireOrg(orgId);
        if (StringUtils.hasText(request.name())) {
            organization.setName(request.name());
        }
        if (request.logoUrl() != null) {
            organization.setLogoUrl(request.logoUrl());
        }
        if (request.contactName() != null) {
            organization.setContactName(request.contactName());
        }
        if (request.contactPhone() != null) {
            organization.setContactPhone(request.contactPhone());
        }
        if (StringUtils.hasText(request.timezone())) {
            organization.setTimezone(request.timezone());
        }
        if (request.maxMembers() != null) {
            if (request.maxMembers() <= 0) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "成员上限必须大于 0");
            }
            organization.setMaxMembers(request.maxMembers());
        }
        organizationMapper.updateById(organization);
        auditLogService.record(principal, "ORG_UPDATE", "ORGANIZATION", orgId, null);
        return toResponse(organization);
    }

    /**
     * 停用 / 启用组织。停用后该组织成员无法访问组织接口（spec §10.1 必测场景 10）。
     */
    @Transactional
    public OrganizationResponse changeStatus(AdminPrincipal principal, Long orgId, String status) {
        if (!STATUSES.contains(status)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "状态取值非法: " + status);
        }
        Organization organization = requireOrg(orgId);
        organization.setStatus(status);
        organizationMapper.updateById(organization);
        auditLogService.record(principal, "ORG_STATUS_CHANGE", "ORGANIZATION", orgId,
                Map.of("status", status));
        return toResponse(organization);
    }

    @Transactional
    public void delete(AdminPrincipal principal, Long orgId) {
        Organization organization = requireOrg(orgId);
        organization.setDeletedAt(OffsetDateTime.now(ZoneOffset.UTC));
        organization.setStatus(Organization.STATUS_DISABLED);
        organizationMapper.updateById(organization);
        auditLogService.record(principal, "ORG_DELETE", "ORGANIZATION", orgId, null);
    }

    public Organization requireOrg(Long orgId) {
        Organization organization = organizationMapper.selectById(orgId);
        if (organization == null || organization.getDeletedAt() != null) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "组织不存在");
        }
        return organization;
    }

    private OrganizationResponse toResponse(Organization organization) {
        return new OrganizationResponse(organization.getId(), organization.getName(),
                organization.getCode(), organization.getLogoUrl(), organization.getTimezone(),
                organization.getStatus(), organization.getMaxMembers(), organization.getCreatedAt());
    }
}
