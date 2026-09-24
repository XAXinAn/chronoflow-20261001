package com.xatodo.auth.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.auth.dto.AuthDtos.IdentitySummary;
import com.xatodo.auth.dto.AuthDtos.SmsLoginResponse;
import com.xatodo.auth.dto.AuthDtos.TokenResponse;
import com.xatodo.auth.dto.IdentityView;
import com.xatodo.auth.entity.Account;
import com.xatodo.auth.entity.Identity;
import com.xatodo.auth.mapper.AccountMapper;
import com.xatodo.auth.mapper.IdentityMapper;
import com.xatodo.auth.security.IdentityPrincipal;
import com.xatodo.auth.security.TokenScope;
import com.xatodo.auth.store.RefreshTokenRecord;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;

/**
 * 认证编排：短信登录 → 身份列表 → 选择身份 → 签发令牌，以及令牌刷新、身份切换与登出。
 * 流程见 spec §3.2。
 */
@Service
public class AuthService {

    private static final String STATUS_ACTIVE = "ACTIVE";
    private static final String STATUS_DISABLED = "DISABLED";

    private final AccountMapper accountMapper;
    private final IdentityMapper identityMapper;
    private final VerificationCodeService verificationCodeService;
    private final TokenService tokenService;

    public AuthService(AccountMapper accountMapper,
                       IdentityMapper identityMapper,
                       VerificationCodeService verificationCodeService,
                       TokenService tokenService) {
        this.accountMapper = accountMapper;
        this.identityMapper = identityMapper;
        this.verificationCodeService = verificationCodeService;
        this.tokenService = tokenService;
    }

    /**
     * 手机号 + 验证码登录。注册与登录合一：手机号首次登录时自动创建账号。
     */
    @Transactional
    public SmsLoginResponse loginBySms(String phone, String code) {
        verificationCodeService.verify(phone, code);

        Account account = accountMapper.selectOne(
                new LambdaQueryWrapper<Account>().eq(Account::getPhone, phone));
        if (account == null) {
            account = createAccount(phone);
        } else {
            if (STATUS_DISABLED.equals(account.getStatus())) {
                throw BizException.of(ErrorCode.ACCOUNT_DISABLED);
            }
            account.setLastLoginAt(OffsetDateTime.now(ZoneOffset.UTC));
            accountMapper.updateById(account);
        }

        List<IdentityView> identities = identityMapper.selectIdentityViews(account.getId());
        if (identities.isEmpty()) {
            String registerToken = tokenService.issueScopedToken(
                    account.getId(), TokenScope.REGISTER, tokenService.properties().getRegisterTokenTtl());
            return new SmsLoginResponse(true, registerToken, false, null, List.of());
        }

        String selectToken = tokenService.issueScopedToken(
                account.getId(), TokenScope.IDENTITY_SELECT, tokenService.properties().getSelectTokenTtl());
        return new SmsLoginResponse(false, null, true, selectToken, identities);
    }

    /**
     * 创建个人身份并直接签发令牌（首次登录后的引导步骤）。
     */
    @Transactional
    public TokenResponse createPersonalIdentity(Long accountId, String nickname, String avatarUrl, String deviceId) {
        Account account = accountMapper.selectById(accountId);
        if (account == null) {
            throw BizException.of(ErrorCode.UNAUTHENTICATED);
        }

        Long existing = identityMapper.selectCount(new LambdaQueryWrapper<Identity>()
                .eq(Identity::getAccountId, accountId)
                .eq(Identity::getIdentityType, Identity.TYPE_PERSONAL));
        if (existing != null && existing > 0) {
            throw BizException.of(ErrorCode.MEMBER_ALREADY_EXISTS, "该账号已存在个人身份");
        }

        Identity identity = new Identity();
        identity.setAccountId(accountId);
        identity.setIdentityType(Identity.TYPE_PERSONAL);
        identity.setNickname(StringUtils.hasText(nickname) ? nickname : defaultNickname(account.getPhone()));
        identity.setAvatarUrl(avatarUrl);
        identity.setStatus(STATUS_ACTIVE);
        identityMapper.insert(identity);

        return issueTokens(accountId, identity.getId(), Identity.TYPE_PERSONAL, null, deviceId);
    }

    /**
     * 选定身份并签发令牌。
     */
    @Transactional
    public TokenResponse selectIdentity(Long accountId, Long identityId, String deviceId) {
        Identity identity = requireOwnedIdentity(accountId, identityId);
        return issueTokens(accountId, identity.getId(), identity.getIdentityType(), identity.getOrgId(), deviceId);
    }

    /**
     * 刷新访问令牌：旧刷新令牌立即失效（轮换），避免长期复用。
     */
    @Transactional
    public TokenResponse refresh(String refreshToken, String deviceId) {
        RefreshTokenRecord record = tokenService.requireRefreshToken(refreshToken);
        Identity identity = requireActiveIdentity(record.identityId());
        tokenService.revokeRefreshToken(refreshToken);
        return issueTokens(record.accountId(), identity.getId(), identity.getIdentityType(),
                identity.getOrgId(), deviceId);
    }

    /**
     * 切换身份：凭刷新令牌换发绑定目标身份的新令牌，无需重新走验证码。
     */
    @Transactional
    public TokenResponse switchIdentity(String refreshToken, Long targetIdentityId, String deviceId) {
        RefreshTokenRecord record = tokenService.requireRefreshToken(refreshToken);
        Identity identity = requireOwnedIdentity(record.accountId(), targetIdentityId);
        tokenService.revokeRefreshToken(refreshToken);
        return issueTokens(record.accountId(), identity.getId(), identity.getIdentityType(),
                identity.getOrgId(), deviceId);
    }

    public void logout(String refreshToken) {
        tokenService.revokeRefreshToken(refreshToken);
    }

    public List<IdentityView> listIdentities(Long accountId) {
        return identityMapper.selectIdentityViews(accountId);
    }

    public IdentityView currentIdentityView(Long accountId, Long identityId) {
        return identityMapper.selectIdentityViews(accountId).stream()
                .filter(view -> view.getIdentityId().equals(identityId))
                .findFirst()
                .orElseThrow(() -> BizException.of(ErrorCode.IDENTITY_UNAVAILABLE));
    }

    private Account createAccount(String phone) {
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        Account account = new Account();
        account.setPhone(phone);
        account.setPhoneVerifiedAt(now);
        account.setStatus(STATUS_ACTIVE);
        account.setLastLoginAt(now);
        accountMapper.insert(account);
        return account;
    }

    private Identity requireOwnedIdentity(Long accountId, Long identityId) {
        Identity identity = requireActiveIdentity(identityId);
        if (!identity.getAccountId().equals(accountId)) {
            throw BizException.of(ErrorCode.IDENTITY_NOT_OWNED);
        }
        return identity;
    }

    private Identity requireActiveIdentity(Long identityId) {
        Identity identity = identityMapper.selectById(identityId);
        if (identity == null || !STATUS_ACTIVE.equals(identity.getStatus())) {
            throw BizException.of(ErrorCode.IDENTITY_UNAVAILABLE);
        }
        return identity;
    }

    private TokenResponse issueTokens(Long accountId, Long identityId, String identityType,
                                      Long orgId, String deviceId) {
        IdentityPrincipal principal = new IdentityPrincipal(accountId, identityId, identityType, orgId);
        String accessToken = tokenService.issueAccessToken(principal);
        String refreshToken = tokenService.issueRefreshToken(accountId, identityId, deviceId);

        Identity identity = identityMapper.selectById(identityId);
        IdentitySummary summary = new IdentitySummary(
                accountId, identityId, identityType, orgId,
                identity == null ? null : identity.getNickname(),
                identity == null ? null : identity.getAvatarUrl());

        return new TokenResponse(accessToken, refreshToken, tokenService.accessTokenTtlSeconds(), summary);
    }

    private String defaultNickname(String phone) {
        return phone.length() >= 4 ? "用户" + phone.substring(phone.length() - 4) : "用户";
    }
}
