package com.xatodo.auth.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.xatodo.auth.dto.AuthDtos.DeviceResponse;
import com.xatodo.auth.dto.AuthDtos.SetPasswordRequest;
import com.xatodo.auth.dto.AuthDtos.UpdateProfileRequest;
import com.xatodo.auth.entity.Account;
import com.xatodo.auth.entity.Identity;
import com.xatodo.auth.mapper.AccountMapper;
import com.xatodo.auth.mapper.IdentityMapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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

    public AccountService(AccountMapper accountMapper,
                          IdentityMapper identityMapper,
                          TokenService tokenService,
                          PasswordEncoder passwordEncoder,
                          ObjectMapper objectMapper) {
        this.accountMapper = accountMapper;
        this.identityMapper = identityMapper;
        this.tokenService = tokenService;
        this.passwordEncoder = passwordEncoder;
        this.objectMapper = objectMapper;
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
}
