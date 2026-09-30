package com.xatodo.agent.tool;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.auth.entity.Identity;
import com.xatodo.auth.mapper.IdentityMapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.org.entity.OrgMember;
import com.xatodo.org.entity.Organization;
import com.xatodo.org.mapper.OrgMemberMapper;
import com.xatodo.org.mapper.OrganizationMapper;
import org.springframework.stereotype.Service;

/**
 * 把「当前账号 + 客户端传来的 orgIdentityId」解析成助手的可见范围。
 *
 * <p><b>越权校验就在这里</b>：请求体里的 {@code orgIdentityId} 是不能信的输入，
 * 必须确认它确实属于当前账号、且是一条可用的组织身份。校验放在服务层而不是控制器，
 * 是为了将来任何入口都自动受同一套规则约束。
 */
@Service
public class AgentScopeResolver {

    private final IdentityMapper identityMapper;
    private final OrgMemberMapper orgMemberMapper;
    private final OrganizationMapper organizationMapper;

    public AgentScopeResolver(IdentityMapper identityMapper,
                              OrgMemberMapper orgMemberMapper,
                              OrganizationMapper organizationMapper) {
        this.identityMapper = identityMapper;
        this.orgMemberMapper = orgMemberMapper;
        this.organizationMapper = organizationMapper;
    }

    public AgentScope resolve(Long accountId, Long orgIdentityId) {
        Long personalIdentityId = personalIdentityId(accountId);
        if (orgIdentityId == null) {
            return new AgentScope(accountId, personalIdentityId, null, null, null, null);
        }

        Identity identity = identityMapper.selectById(orgIdentityId);
        if (identity == null
                || !accountId.equals(identity.getAccountId())
                || !Identity.TYPE_ORG_MEMBER.equals(identity.getIdentityType())
                || identity.getOrgId() == null) {
            // 注意措辞：不透露该身份是否存在，只说「不属于当前账号」
            throw BizException.of(ErrorCode.FORBIDDEN, "该组织身份不属于当前账号");
        }

        OrgMember member = orgMemberMapper.selectOne(new LambdaQueryWrapper<OrgMember>()
                .eq(OrgMember::getOrgId, identity.getOrgId())
                .eq(OrgMember::getIdentityId, identity.getId()));
        if (member == null || !OrgMember.STATUS_ACTIVE.equals(member.getStatus())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "组织成员身份已停用或不存在");
        }
        Organization org = organizationMapper.selectById(identity.getOrgId());
        if (org == null || !Organization.STATUS_ACTIVE.equals(org.getStatus())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "组织已停用");
        }
        return new AgentScope(accountId, personalIdentityId, orgIdentityId, org.getId(),
                org.getName(), member);
    }

    /**
     * 当前账号的个人身份。
     *
     * <p>刻意不直接用令牌里的 {@code identityId}：助手可能被组织身份令牌调用
     * （比如以后用户正泡在组织视图里点开小安），而个人日程挂在**个人身份**的日历下。
     * 用账号去找个人身份，两种入口都能正确查到自己的日程。
     */
    private Long personalIdentityId(Long accountId) {
        Identity personal = identityMapper.selectOne(new LambdaQueryWrapper<Identity>()
                .eq(Identity::getAccountId, accountId)
                .eq(Identity::getIdentityType, Identity.TYPE_PERSONAL)
                .last("limit 1"));
        if (personal == null) {
            throw BizException.of(ErrorCode.IDENTITY_UNAVAILABLE, "当前账号没有可用的个人身份");
        }
        return personal.getId();
    }
}
