package com.chronoflow.org.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import com.chronoflow.org.dto.OrgDtos.OrgSettingsResponse;
import com.chronoflow.org.dto.OrgDtos.OrgSettingsUpdateRequest;
import com.chronoflow.org.entity.OrgMember;
import com.chronoflow.org.entity.Organization;
import com.chronoflow.org.mapper.OrgMemberMapper;
import com.chronoflow.org.mapper.OrganizationMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.DateTimeException;
import java.time.ZoneId;

/**
 * 组织设置（spec §4.3「组织设置」）。
 *
 * <p>成员上限只读：它由平台超管在 §4.4 侧控制，组织侧不能自行上调，否则就成了「自己给自己扩容」。
 */
@Service
public class OrgSettingsService {

    private final OrganizationMapper organizationMapper;
    private final OrgMemberMapper orgMemberMapper;
    private final OrgPermissionService permission;

    public OrgSettingsService(OrganizationMapper organizationMapper,
                              OrgMemberMapper orgMemberMapper,
                              OrgPermissionService permission) {
        this.organizationMapper = organizationMapper;
        this.orgMemberMapper = orgMemberMapper;
        this.permission = permission;
    }

    public OrgSettingsResponse get(OrgActor actor) {
        permission.requireOrgAdmin(actor);
        return toResponse(permission.requireActiveOrganization(actor.getOrgId()));
    }

    @Transactional
    public OrgSettingsResponse update(OrgActor actor, OrgSettingsUpdateRequest request) {
        permission.requireOrgAdmin(actor);
        Organization organization = permission.requireActiveOrganization(actor.getOrgId());

        if (StringUtils.hasText(request.name())) {
            organization.setName(request.name().trim());
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
            String timezone = request.timezone().trim();
            try {
                ZoneId.of(timezone);
            } catch (DateTimeException ex) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "时区不合法: " + timezone);
            }
            organization.setTimezone(timezone);
        }
        organizationMapper.updateById(organization);
        return toResponse(organization);
    }

    private OrgSettingsResponse toResponse(Organization organization) {
        Long members = orgMemberMapper.selectCount(new LambdaQueryWrapper<OrgMember>()
                .eq(OrgMember::getOrgId, organization.getId())
                .ne(OrgMember::getStatus, OrgMember.STATUS_LEFT));
        return new OrgSettingsResponse(organization.getId(), organization.getName(),
                organization.getCode(), organization.getLogoUrl(), organization.getContactName(),
                organization.getContactPhone(), organization.getTimezone(), organization.getStatus(),
                organization.getMaxMembers(), members == null ? 0 : members);
    }
}
