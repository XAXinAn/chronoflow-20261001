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
import java.util.Optional;

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

        String refreshToken = tokenService.issueRefreshToken(accountId, identity.getId(), deviceId);
        return buildTokenResponse(accountId, identity, refreshToken);
    }

    /**
     * 选定身份并签发令牌。
     */
    @Transactional
    public TokenResponse selectIdentity(Long accountId, Long identityId, String deviceId) {
        Identity identity = requireOwnedIdentity(accountId, identityId);
        String refreshToken = tokenService.issueRefreshToken(accountId, identity.getId(), deviceId);
        return buildTokenResponse(accountId, identity, refreshToken);
    }

    /**
     * 刷新访问令牌。刷新令牌采用滑动过期 + 轮换：只要用户在刷新令牌有效期内使用过 App，
     * 有效期就自动延长，因此正常使用过程中不会被打断（spec §3.7）。
     *
     * <p>并发刷新（App 同时发起多个请求）通过轮换宽限期兜底：旧令牌在宽限期内被再次提交时，
     * 返回同一个新令牌，而不是判定为失效并强制用户重新登录。
     */
    @Transactional
    public TokenResponse refresh(String refreshToken, String deviceId) {
        Optional<RefreshTokenRecord> current = tokenService.findRefreshToken(refreshToken);
        if (current.isEmpty()) {
            return reuseRotatedSuccessor(refreshToken);
        }

        RefreshTokenRecord record = current.get();
        requireActiveAccount(record.accountId());
        Identity identity = requireActiveIdentity(record.identityId());

        String newRefreshToken = tokenService.issueRefreshToken(record.accountId(), identity.getId(), deviceId);
        tokenService.linkRotation(refreshToken, newRefreshToken);
        return buildTokenResponse(record.accountId(), identity, newRefreshToken);
    }

    /**
     * 切换身份：凭刷新令牌换发绑定目标身份的新令牌，无需重新走验证码。
     */
    @Transactional
    public TokenResponse switchIdentity(String refreshToken, Long targetIdentityId, String deviceId) {
        RefreshTokenRecord record = tokenService.requireRefreshToken(refreshToken);
        requireActiveAccount(record.accountId());
        // 目标身份非法时直接失败，且不消耗原刷新令牌，避免误踢用户
        Identity identity = requireOwnedIdentity(record.accountId(), targetIdentityId);

        String newRefreshToken = tokenService.issueRefreshToken(record.accountId(), identity.getId(), deviceId);
        tokenService.linkRotation(refreshToken, newRefreshToken);
        return buildTokenResponse(record.accountId(), identity, newRefreshToken);
    }

    /**
     * 宽限期内的并发刷新兜底：旧令牌已被轮换掉，但轮换关系仍在，取回同一个新令牌。
     */
    private TokenResponse reuseRotatedSuccessor(String previousRefreshToken) {
        String successorToken = tokenService.findRotatedSuccessor(previousRefreshToken)
                .orElseThrow(() -> BizException.of(ErrorCode.REFRESH_TOKEN_INVALID));
        RefreshTokenRecord successor = tokenService.findRefreshToken(successorToken)
                .orElseThrow(() -> BizException.of(ErrorCode.REFRESH_TOKEN_INVALID));
        requireActiveAccount(successor.accountId());
        Identity identity = requireActiveIdentity(successor.identityId());
        return buildTokenResponse(successor.accountId(), identity, successor.tokenId());
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

    private TokenResponse buildTokenResponse(Long accountId, Identity identity, String refreshToken) {
        IdentityPrincipal principal = new IdentityPrincipal(
                accountId, identity.getId(), identity.getIdentityType(), identity.getOrgId());
        String accessToken = tokenService.issueAccessToken(principal);

        IdentitySummary summary = new IdentitySummary(
                accountId, identity.getId(), identity.getIdentityType(), identity.getOrgId(),
                identity.getNickname(), identity.getAvatarUrl());

        return new TokenResponse(accessToken, refreshToken, tokenService.accessTokenTtlSeconds(), summary);
    }

    /**
     * 账号被停用时立即吊销其全部刷新令牌，下一次刷新即要求重新登录（spec §10.1 必测场景 9）。
     */
    private Account requireActiveAccount(Long accountId) {
        Account account = accountMapper.selectById(accountId);
        if (account == null) {
            throw BizException.of(ErrorCode.UNAUTHENTICATED);
        }
        if (STATUS_DISABLED.equals(account.getStatus())) {
            tokenService.revokeAllForAccount(accountId);
            throw BizException.of(ErrorCode.ACCOUNT_DISABLED);
        }
        return account;
    }

    private String defaultNickname(String phone) {
        return phone.length() >= 4 ? "用户" + phone.substring(phone.length() - 4) : "用户";
    }
}
