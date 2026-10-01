package com.chronoflow.org.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.chronoflow.auth.dto.AuthDtos.TokenResponse;
import com.chronoflow.auth.entity.Identity;
import com.chronoflow.auth.mapper.IdentityMapper;
import com.chronoflow.auth.security.IdentityPrincipal;
import com.chronoflow.auth.service.AuthService;
import com.chronoflow.auth.service.TokenService;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import com.chronoflow.org.dto.OrgDtos.OrgAccountResponse;
import com.chronoflow.org.entity.Department;
import com.chronoflow.org.entity.OrgMember;
import com.chronoflow.org.entity.Organization;
import com.chronoflow.org.mapper.OrgMemberMapper;
import com.chronoflow.org.mapper.OrganizationMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;

/**
 * 组织账号：认领（登录）、列表与解绑（spec §3.1 / §3.2 / §4.2.5）。
 *
 * <p>这一组接口都用**个人身份**的令牌调用——它们作用于「当前个人账号绑定了哪些组织账号」，
 * 而 {@code /org/**} 用**组织身份**的令牌调用。两套上下文在这里交界，别混。
 *
 * <p>为什么是「认领」而不是「密码登录」：组织侧导入成员时只写唯一识别 ID（学号/工号），
 * 不设密码。取舍与加固方向写在 spec §3.1 的安全说明里——首版认领到的只是一个只读的
 * 组织日历视图，但必须提供管理员解绑，否则被冒领的人没有恢复路径。
 */
@Service
public class OrgAccountService {

    private final OrgMemberMapper orgMemberMapper;
    private final OrganizationMapper organizationMapper;
    private final IdentityMapper identityMapper;
    private final DepartmentService departmentService;
    private final OrgMemberService orgMemberService;
    private final AuthService authService;
    private final TokenService tokenService;

    public OrgAccountService(OrgMemberMapper orgMemberMapper,
                             OrganizationMapper organizationMapper,
                             IdentityMapper identityMapper,
                             DepartmentService departmentService,
                             OrgMemberService orgMemberService,
                             AuthService authService,
                             TokenService tokenService) {
        this.orgMemberMapper = orgMemberMapper;
        this.organizationMapper = organizationMapper;
        this.identityMapper = identityMapper;
        this.departmentService = departmentService;
        this.orgMemberService = orgMemberService;
        this.authService = authService;
        this.tokenService = tokenService;
    }

    /**
     * 登录组织账号 = 认领并绑定。
     *
     * <p>幂等：重复登录复用同一个组织身份；解绑后重新认领会把原身份重新激活，
     * 不会再建一条（否则会撞上 `(account_id, org_id)` 唯一键）。
     */
    @Transactional
    public LoginResult login(Long accountId, String org, String memberKey, String deviceId) {
        Organization organization = requireActiveOrg(org);
        String key = memberKey == null ? "" : memberKey.trim();
        if (key.isEmpty()) {
            throw BizException.of(ErrorCode.PARAM_MISSING, "成员唯一识别 ID 不能为空");
        }
        OrgMember member = orgMemberMapper.selectOne(new LambdaQueryWrapper<OrgMember>()
                .eq(OrgMember::getOrgId, organization.getId())
                .eq(OrgMember::getMemberKey, key));
        if (member == null) {
            // 不区分「组织不对」与「成员不对」：否则这个接口就成了组织成员名单的探测工具
            throw BizException.of(ErrorCode.FORBIDDEN, "组织唯一 ID 或成员唯一识别 ID 不正确");
        }
        if (!OrgMember.STATUS_ACTIVE.equals(member.getStatus())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该成员已离职或停用，请联系组织管理员");
        }

        Identity identity = ensureIdentity(accountId, organization.getId(), member);
        member.setLastLoginAt(OffsetDateTime.now(ZoneOffset.UTC));
        orgMemberMapper.updateById(member);

        TokenResponse tokens = authService.selectIdentity(accountId, identity.getId(), deviceId);
        return new LoginResult(toView(member, organization, identity),
                tokens.accessToken(), tokens.refreshToken(), tokens.expiresIn());
    }

    /** 我绑定过的组织账号。只列仍然有效的绑定（解绑后身份被停用，自然不在列表里）。 */
    public List<OrgAccountResponse> list(Long accountId) {
        List<Identity> identities = identityMapper.selectList(new LambdaQueryWrapper<Identity>()
                .eq(Identity::getAccountId, accountId)
                .eq(Identity::getIdentityType, Identity.TYPE_ORG_MEMBER)
                .eq(Identity::getStatus, "ACTIVE")
                .orderByDesc(Identity::getId));

        List<OrgAccountResponse> result = new ArrayList<>();
        for (Identity identity : identities) {
            OrgMember member = orgMemberMapper.selectOne(new LambdaQueryWrapper<OrgMember>()
                    .eq(OrgMember::getIdentityId, identity.getId()));
            Organization organization = organizationMapper.selectById(identity.getOrgId());
            if (member == null || organization == null || organization.getDeletedAt() != null) {
                continue;
            }
            result.add(toView(member, organization, identity));
        }
        return result;
    }

    /** 解绑（删除登录记录）：停用组织身份 + 吊销令牌 + 清掉认领关系，成员记录保留。 */
    @Transactional
    public void unlink(Long accountId, Long identityId) {
        Identity identity = identityMapper.selectById(identityId);
        if (identity == null || !Identity.TYPE_ORG_MEMBER.equals(identity.getIdentityType())
                || !accountId.equals(identity.getAccountId())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该组织账号不属于当前账号");
        }
        OrgMember member = orgMemberMapper.selectOne(new LambdaQueryWrapper<OrgMember>()
                .eq(OrgMember::getIdentityId, identityId));
        if (member != null) {
            orgMemberService.unbindInternal(member);
            return;
        }
        // 成员记录已经不在（例如被组织删除）：至少把身份停用、令牌吊销掉
        identity.setStatus("DISABLED");
        identityMapper.updateById(identity);
        tokenService.revokeAllForIdentity(identityId);
    }

    /** 该接口只对个人身份开放：拿组织身份调它没有意义，只会让人误以为绑定了别的组织。 */
    public void requirePersonal(IdentityPrincipal principal) {
        if (principal.isOrgIdentity()) {
            throw BizException.of(ErrorCode.FORBIDDEN, "该接口需用个人身份调用");
        }
    }

    /**
     * 解析组织唯一 ID：先按组织编码精确匹配，没有则按数字 ID 匹配。
     *
     * <p>用户在 App 里只填一个框，编码（XATECH）和数字 ID 都能用——组织编码是人事侧常用的，
     * 数字 ID 是平台侧的，两个都认比逼用户记住用哪个更好。
     */
    private Organization requireActiveOrg(String org) {
        String value = org == null ? "" : org.trim();
        if (value.isEmpty()) {
            throw BizException.of(ErrorCode.PARAM_MISSING, "组织唯一 ID 不能为空");
        }
        Organization organization = organizationMapper.selectOne(new LambdaQueryWrapper<Organization>()
                .eq(Organization::getCode, value)
                .last("LIMIT 1"));
        if (organization == null && value.matches("\\d+")) {
            organization = organizationMapper.selectById(Long.valueOf(value));
        }
        if (organization == null || organization.getDeletedAt() != null) {
            throw BizException.of(ErrorCode.FORBIDDEN, "组织不存在");
        }
        if (!Organization.STATUS_ACTIVE.equals(organization.getStatus())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "组织已停用");
        }
        return organization;
    }

    private Identity ensureIdentity(Long accountId, Long orgId, OrgMember member) {
        if (member.getIdentityId() != null) {
            Identity bound = identityMapper.selectById(member.getIdentityId());
            if (bound != null) {
                if (!accountId.equals(bound.getAccountId())) {
                    throw BizException.of(ErrorCode.FORBIDDEN,
                            "该组织账号已被其他个人账号认领，请联系组织管理员解绑");
                }
                if (!"ACTIVE".equals(bound.getStatus())) {
                    // 解绑过又重新认领：复用原身份，避免撞 (account_id, org_id) 唯一键
                    bound.setStatus("ACTIVE");
                    identityMapper.updateById(bound);
                }
                return bound;
            }
        }

        Identity identity = identityMapper.selectOne(new LambdaQueryWrapper<Identity>()
                .eq(Identity::getAccountId, accountId)
                .eq(Identity::getOrgId, orgId)
                .last("LIMIT 1"));
        if (identity == null) {
            identity = new Identity();
            identity.setAccountId(accountId);
            identity.setIdentityType(Identity.TYPE_ORG_MEMBER);
            identity.setOrgId(orgId);
            identity.setNickname(member.getRealName());
            identity.setStatus("ACTIVE");
            identityMapper.insert(identity);
            // 回写认领关系：不写这一步，身份虽然建出来了，但 /org/** 查不到成员，等于没绑定
            member.setIdentityId(identity.getId());
            return identity;
        }
        // 这个身份可能已经被同组织里的**另一个成员**占着（一个账号在同一组织只能绑一个成员账号）：
        // 直接复用会撞 uk_org_member_identity，所以要拦下来并说清楚怎么恢复
        OrgMember other = orgMemberMapper.selectOne(new LambdaQueryWrapper<OrgMember>()
                .eq(OrgMember::getOrgId, orgId)
                .eq(OrgMember::getIdentityId, identity.getId())
                .last("LIMIT 1"));
        if (other != null && !other.getId().equals(member.getId())) {
            throw BizException.of(ErrorCode.FORBIDDEN,
                    "该账号在本组织已绑定成员「" + other.getRealName() + "」，请先在账户管理里解绑");
        }
        if (!"ACTIVE".equals(identity.getStatus())) {
            identity.setStatus("ACTIVE");
            identityMapper.updateById(identity);
        }
        member.setIdentityId(identity.getId());
        return identity;
    }

    private OrgAccountResponse toView(OrgMember member, Organization organization, Identity identity) {
        String departmentName = null;
        if (member.getDepartmentId() != null) {
            Department department =
                    departmentService.requireInOrg(organization.getId(), member.getDepartmentId());
            departmentName = department == null ? null : department.getName();
        }
        return new OrgAccountResponse(
                identity.getId(), organization.getId(), organization.getName(), organization.getCode(),
                member.getMemberKey(), StringUtils.hasText(member.getRealName())
                        ? member.getRealName() : identity.getNickname(),
                departmentName, member.getOrgRole(), member.getLastLoginAt());
    }

    /** 登录组织账号的结果：组织账号视图 + 该组织身份的令牌对。 */
    public record LoginResult(OrgAccountResponse account,
                              String accessToken,
                              String refreshToken,
                              long expiresIn) {
    }
}
