package com.xatodo.support.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.support.entity.PushDevice;
import com.xatodo.support.mapper.PushDeviceMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Set;

/**
 * 推送设备注册表（spec §4.5）。
 *
 * <p>App 拿到 registrationId 后上报，服务端才知道「组织日程下发给这些人」时往哪几台设备发。
 */
@Service
public class PushDeviceService {

    private static final Set<String> PLATFORMS = Set.of("android", "ios");

    private final PushDeviceMapper mapper;

    public PushDeviceService(PushDeviceMapper mapper) {
        this.mapper = mapper;
    }

    /**
     * 上报/刷新一台设备。
     *
     * <p>用 registrationId 做幂等键：换账号登录时**改绑**到新账号，而不是让两台设备共用一个标识
     * （共用的话推送会发给上一个用户，那是数据泄露）。
     */
    @Transactional
    public PushDevice register(Long accountId, Long identityId, String registrationId,
                               String platform, String appVersion) {
        if (!StringUtils.hasText(registrationId)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "registrationId 不能为空");
        }
        String normalizedPlatform = StringUtils.hasText(platform) ? platform.trim().toLowerCase() : null;
        if (normalizedPlatform != null && !PLATFORMS.contains(normalizedPlatform)) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "platform 取值非法: " + platform);
        }

        PushDevice existing = mapper.selectOne(new LambdaQueryWrapper<PushDevice>()
                .eq(PushDevice::getProvider, PushDevice.PROVIDER_JPUSH)
                .eq(PushDevice::getRegistrationId, registrationId));
        OffsetDateTime now = OffsetDateTime.now();
        if (existing == null) {
            PushDevice device = new PushDevice();
            device.setAccountId(accountId);
            device.setIdentityId(identityId);
            device.setProvider(PushDevice.PROVIDER_JPUSH);
            device.setRegistrationId(registrationId);
            device.setPlatform(normalizedPlatform);
            device.setAppVersion(appVersion);
            device.setCreatedAt(now);
            device.setUpdatedAt(now);
            mapper.insert(device);
            return device;
        }
        existing.setAccountId(accountId);
        existing.setIdentityId(identityId);
        existing.setPlatform(normalizedPlatform);
        existing.setAppVersion(appVersion);
        existing.setUpdatedAt(now);
        // 重新上报即视为重新启用（用户可能只是重装/换机后回到这个标识）
        existing.setDisabledAt(null);
        mapper.updateById(existing);
        return existing;
    }

    /** 注销：只允许注销自己账号名下的设备。 */
    @Transactional
    public void unregister(Long accountId, String registrationId) {
        int updated = mapper.update(null, new LambdaUpdateWrapper<PushDevice>()
                .eq(PushDevice::getAccountId, accountId)
                .eq(PushDevice::getRegistrationId, registrationId)
                .set(PushDevice::getDisabledAt, OffsetDateTime.now())
                .set(PushDevice::getUpdatedAt, OffsetDateTime.now()));
        if (updated == 0) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "该设备不存在或不属于当前账号");
        }
    }

    public List<PushDevice> listMine(Long accountId) {
        return mapper.selectList(new LambdaQueryWrapper<PushDevice>()
                .eq(PushDevice::getAccountId, accountId)
                .isNull(PushDevice::getDisabledAt)
                .orderByDesc(PushDevice::getUpdatedAt));
    }

    /**
     * 一批**账号**名下的活跃推送标识（发推送前查）。
     *
     * <p>注意入参是账号而不是身份：推送设备是「这台手机」的属性，用户可能在个人身份下上报它，
     * 而组织日程要推给同一个人的**组织身份**。按身份查会一条都命不中——
     * 一个账号下的所有身份共用同一批设备。
     */
    public List<String> activeRegistrationIdsForAccounts(List<Long> accountIds) {
        if (accountIds == null || accountIds.isEmpty()) {
            return List.of();
        }
        return mapper.selectList(new LambdaQueryWrapper<PushDevice>()
                        .in(PushDevice::getAccountId, accountIds)
                        .isNull(PushDevice::getDisabledAt))
                .stream()
                .map(PushDevice::getRegistrationId)
                .distinct()
                .toList();
    }

    /** 通道说这些标识失效了，停用它们（否则每次推送都会重复失败）。 */
    @Transactional
    public void disableByRegistrationIds(List<String> registrationIds) {
        if (registrationIds == null || registrationIds.isEmpty()) {
            return;
        }
        mapper.update(null, new LambdaUpdateWrapper<PushDevice>()
                .in(PushDevice::getRegistrationId, registrationIds)
                .isNull(PushDevice::getDisabledAt)
                .set(PushDevice::getDisabledAt, OffsetDateTime.now()));
    }
}
