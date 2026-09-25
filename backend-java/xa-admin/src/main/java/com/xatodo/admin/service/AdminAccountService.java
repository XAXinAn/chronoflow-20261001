package com.xatodo.admin.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.admin.dto.AdminDtos.AccountIdentityResponse;
import com.xatodo.admin.dto.AdminDtos.AccountResponse;
import com.xatodo.admin.security.AdminPrincipal;
import com.xatodo.auth.entity.Account;
import com.xatodo.auth.entity.Identity;
import com.xatodo.auth.mapper.AccountMapper;
import com.xatodo.auth.mapper.IdentityMapper;
import com.xatodo.auth.service.TokenService;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.org.entity.Organization;
import com.xatodo.org.mapper.OrganizationMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 平台账号管理：检索、封禁 / 解封、单身份停用、强制登出（spec §4.4）。
 */
@Service
public class AdminAccountService {

    private static final Set<String> STATUSES = Set.of("ACTIVE", "DISABLED");

    private final AccountMapper accountMapper;
    private final IdentityMapper identityMapper;
    private final OrganizationMapper organizationMapper;
    private final TokenService tokenService;
    private final AuditLogService auditLogService;

    public AdminAccountService(AccountMapper accountMapper,
                               IdentityMapper identityMapper,
                               OrganizationMapper organizationMapper,
                               TokenService tokenService,
                               AuditLogService auditLogService) {
        this.accountMapper = accountMapper;
        this.identityMapper = identityMapper;
        this.organizationMapper = organizationMapper;
        this.tokenService = tokenService;
        this.auditLogService = auditLogService;
    }

    public List<AccountResponse> search(String phone, String status, int limit) {
        LambdaQueryWrapper<Account> query = new LambdaQueryWrapper<Account>()
                .orderByDesc(Account::getId)
                .last("LIMIT " + Math.min(Math.max(limit, 1), 200));
        if (StringUtils.hasText(phone)) {
            query.like(Account::getPhone, phone);
        }
        if (StringUtils.hasText(status)) {
            query.eq(Account::getStatus, status);
        }
        List<Account> accounts = accountMapper.selectList(query);
        if (accounts.isEmpty()) {
            return List.of();
        }

        Map<Long, Organization> organizations = new HashMap<>();
        organizationMapper.selectList(new LambdaQueryWrapper<Organization>())
                .forEach(org -> organizations.put(org.getId(), org));

        List<AccountResponse> result = new ArrayList<>();
        for (Account account : accounts) {
            List<Identity> identities = identityMapper.selectList(new LambdaQueryWrapper<Identity>()
                    .eq(Identity::getAccountId, account.getId())
                    .orderByAsc(Identity::getId));
            List<AccountIdentityResponse> views = identities.stream()
                    .map(identity -> {
                        Organization org = identity.getOrgId() == null ? null : organizations.get(identity.getOrgId());
                        return new AccountIdentityResponse(identity.getId(), identity.getIdentityType(),
                                identity.getOrgId(), org == null ? null : org.getName(),
                                identity.getNickname(), identity.getStatus());
                    })
                    .toList();
            result.add(new AccountResponse(account.getId(), account.getPhone(), account.getEmail(),
                    account.getWechatUnionid() == null ? null : "BOUND",
                    account.getStatus(), account.getLastLoginAt(), account.getCreatedAt(), views));
        }
        return result;
    }

    /**
     * 封禁 / 解封账号；封禁同时吊销全部刷新令牌，使线上会话立即失效（spec §10.1 必测场景 9）。
     */
    @Transactional
    public AccountResponse changeStatus(AdminPrincipal principal, Long accountId, String status) {
        if (!STATUSES.contains(status)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "状态取值非法: " + status);
        }
        Account account = requireAccount(accountId);
        account.setStatus(status);
        accountMapper.updateById(account);
        if ("DISABLED".equals(status)) {
            tokenService.revokeAllForAccount(accountId);
        }
        auditLogService.record(principal, "ACCOUNT_STATUS_CHANGE", "ACCOUNT", accountId,
                Map.of("status", status));
        return search(account.getPhone(), null, 1).stream().findFirst()
                .orElseThrow(() -> BizException.of(ErrorCode.INTERNAL_ERROR));
    }

    @Transactional
    public void changeIdentityStatus(AdminPrincipal principal, Long identityId, String status) {
        if (!STATUSES.contains(status)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "状态取值非法: " + status);
        }
        Identity identity = identityMapper.selectById(identityId);
        if (identity == null) {
            throw BizException.of(ErrorCode.IDENTITY_UNAVAILABLE);
        }
        identity.setStatus(status);
        identityMapper.updateById(identity);
        if ("DISABLED".equals(status)) {
            tokenService.revokeAllForAccount(identity.getAccountId());
        }
        auditLogService.record(principal, "IDENTITY_STATUS_CHANGE", "IDENTITY", identityId,
                Map.of("status", status));
    }

    @Transactional
    public void forceLogout(AdminPrincipal principal, Long accountId) {
        requireAccount(accountId);
        tokenService.revokeAllForAccount(accountId);
        auditLogService.record(principal, "ACCOUNT_FORCE_LOGOUT", "ACCOUNT", accountId, null);
    }

    private Account requireAccount(Long accountId) {
        Account account = accountMapper.selectById(accountId);
        if (account == null) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "账号不存在");
        }
        return account;
    }
}
