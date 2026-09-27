package com.xatodo.auth.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.auth.dto.AuthDtos.DeviceResponse;
import com.xatodo.auth.dto.AuthDtos.SetPasswordRequest;
import com.xatodo.auth.dto.AuthDtos.UpdateProfileRequest;
import com.xatodo.auth.entity.Account;
import com.xatodo.auth.entity.Identity;
import com.xatodo.auth.mapper.AccountMapper;
import com.xatodo.auth.mapper.IdentityMapper;
import com.xatodo.auth.spi.AccountDataPurger;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.time.ZoneOffset;

/**
 * 账号设置：资料、密码、通知偏好与登录设备（spec §6.2「账号设置」）。
 */
@Service
public class AccountService {

    private final AccountMapper accountMapper;
    private final IdentityMapper identityMapper;
    private final TokenService tokenService;
    private final PasswordEncoder passwordEncoder;
    private final ObjectMapper objectMapper;
    private final ObjectProvider<AccountDataPurger> dataPurgerProvider;

    /** 注销后昵称统一替换成这个值，避免残留可识别信息。 */
    static final String DELETED_NICKNAME = "已注销用户";

    public AccountService(AccountMapper accountMapper,
                          IdentityMapper identityMapper,
                          TokenService tokenService,
                          PasswordEncoder passwordEncoder,
                          ObjectMapper objectMapper,
                          ObjectProvider<AccountDataPurger> dataPurgerProvider) {
        this.accountMapper = accountMapper;
        this.identityMapper = identityMapper;
        this.tokenService = tokenService;
        this.passwordEncoder = passwordEncoder;
        this.objectMapper = objectMapper;
        this.dataPurgerProvider = dataPurgerProvider;
    }

    @Transactional
    public Identity updateProfile(Long identityId, UpdateProfileRequest request) {
        Identity identity = identityMapper.selectById(identityId);
        if (identity == null) {
            throw BizException.of(ErrorCode.IDENTITY_UNAVAILABLE);
        }
        if (StringUtils.hasText(request.nickname())) {
            identity.setNickname(request.nickname());
        }
        if (request.avatarUrl() != null) {
            identity.setAvatarUrl(request.avatarUrl());
        }
        if (StringUtils.hasText(request.timezone())) {
            identity.setTimezone(request.timezone());
        }
        identityMapper.updateById(identity);
        return identity;
    }

    /**
     * 设置或修改密码。
     *
     * <p>短信注册的账号初始没有密码，此时无需提供原密码；
     * 已有密码则必须校验原密码，避免令牌泄漏后被直接改密。
     */
    @Transactional
    public void setPassword(Long accountId, SetPasswordRequest request) {
        Account account = accountMapper.selectById(accountId);
        if (account == null) {
            throw BizException.of(ErrorCode.UNAUTHENTICATED);
        }
        if (account.getPasswordHash() != null) {
            if (!StringUtils.hasText(request.oldPassword())) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "请提供原密码");
            }
            if (!passwordEncoder.matches(request.oldPassword(), account.getPasswordHash())) {
                throw BizException.of(ErrorCode.PASSWORD_MISMATCH);
            }
        }
        account.setPasswordHash(passwordEncoder.encode(request.newPassword()));
        accountMapper.updateById(account);
    }

    public List<DeviceResponse> devices(Long identityId) {
        return tokenService.listSessionRecords(identityId).stream()
                .map(record -> new DeviceResponse(
                        record.deviceId(),
                        record.issuedAt().atOffset(ZoneOffset.UTC)))
                .toList();
    }

    @Transactional
    public void revokeDevice(Long identityId, String deviceId) {
        if (!tokenService.revokeDevice(identityId, deviceId)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "该设备不存在或已下线");
        }
    }

    /**
     * 通知偏好整体覆盖。
     */
    @Transactional
    public Map<String, Boolean> updateNotificationPrefs(Long identityId, Map<String, Boolean> prefs) {
        Identity identity = identityMapper.selectById(identityId);
        if (identity == null) {
            throw BizException.of(ErrorCode.IDENTITY_UNAVAILABLE);
        }
        Map<String, Boolean> normalized = new LinkedHashMap<>(prefs);
        identity.setNotificationPrefs(toJson(normalized));
        identityMapper.updateById(identity);
        return normalized;
    }

    private String toJson(Map<String, Boolean> prefs) {
        try {
            return objectMapper.writeValueAsString(prefs);
        } catch (JsonProcessingException ex) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "通知偏好格式非法");
        }
    }

    /**
     * 自助注销账号（spec §3.1 / §5.3「注销」，商店规范 §2.7）。
     *
     * <p>顺序是刻意的：**先清外部数据与组织绑定，再动账号本身**。
     * 反过来的话，实现 {@link AccountDataPurger} 的那一侧还要按 account_id 反查身份，
     * 而此时身份已经被停用、手机号已经被匿名化，容易漏清。
     *
     * <p>注销是**不可逆**的：手机号被释放给「重新注册」，因此不保留任何找回路径。
     * 这也是规范要求「APP 承诺完成账号注销的时限不得超过 15 个工作日」下的最强做法——
     * 我们是立即完成，而不是压着时限。
     */
    @Transactional
    public void deleteAccount(Long accountId) {
        Account account = accountMapper.selectById(accountId);
        if (account == null) {
            throw BizException.of(ErrorCode.UNAUTHENTICATED);
        }

        AccountDataPurger purger = dataPurgerProvider.getIfAvailable();
        if (purger != null) {
            purger.purge(accountId);
        }

        // 身份：停用 + 抹掉昵称/头像/通知偏好。
        // 不物理删除，因为组织日程的 creator_identity_id 仍指向它；
        // 但行里已经不含任何可识别个人的信息。
        List<Identity> identities = identityMapper.selectList(
                new LambdaQueryWrapper<Identity>().eq(Identity::getAccountId, accountId));
        for (Identity identity : identities) {
            identity.setStatus("DISABLED");
            identity.setNickname(DELETED_NICKNAME);
            identity.setAvatarUrl(null);
            identity.setNotificationPrefs("{}");
            identityMapper.updateById(identity);
        }

        // 账号：手机号匿名化（原号因此可以被重新注册），第三方绑定与密码一并清空
        account.setPhone(deletedPhone(account.getId()));
        account.setPhoneVerifiedAt(null);
        account.setPasswordHash(null);
        account.setWechatUnionid(null);
        account.setWechatOpenid(null);
        account.setEmail(null);
        account.setEmailVerifiedAt(null);
        account.setStatus("DISABLED");
        accountMapper.updateById(account);

        // 最后吊销令牌：走完上面几步再下线，用户看到的是「注销成功」而不是「登录已失效」。
        // 两件事都要做——吊销刷新令牌只是断掉「续期」，已经签发的 access token 还在有效期内，
        // 必须靠作废标记让它当场失效（否则注销后还能继续写数据）。
        tokenService.revokeAllForAccount(accountId);
        tokenService.revokeAccountAccessTokens(accountId);
    }

    /** 匿名化后的手机号必须全局唯一且一眼能看出是已注销账号。 */
    static String deletedPhone(Long accountId) {
        return "deleted-" + accountId;
    }
}
