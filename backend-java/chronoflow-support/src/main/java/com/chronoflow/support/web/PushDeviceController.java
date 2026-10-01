package com.chronoflow.support.web;

import com.chronoflow.auth.security.CurrentIdentity;
import com.chronoflow.auth.security.IdentityPrincipal;
import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.support.dto.PushDtos.PushDeviceRequest;
import com.chronoflow.support.dto.PushDtos.PushDeviceResponse;
import com.chronoflow.support.entity.PushDevice;
import com.chronoflow.support.service.PushDeviceService;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 推送设备注册（spec §4.5）。
 *
 * <p>App 在极光 SDK 初始化拿到 registrationId 后调这里上报；服务端才知道
 * 「组织日程下发给这些人」时往哪几台设备发。设备标识是账号级资源，
 * 因此挂在 `/me` 下（与 `/me/devices` 的会话列表不是一回事：那个是登录会话，这个是推送标识）。
 */
@RestController
@RequestMapping("/api/v1/me/push-devices")
@SecurityRequirement(name = "bearerAuth")
public class PushDeviceController {

    private final PushDeviceService service;

    public PushDeviceController(PushDeviceService service) {
        this.service = service;
    }

    @PostMapping
    public ApiResponse<PushDeviceResponse> register(@Valid @RequestBody PushDeviceRequest request) {
        IdentityPrincipal principal = CurrentIdentity.require();
        PushDevice device = service.register(principal.accountId(), principal.identityId(),
                request.registrationId(), request.platform(), request.appVersion());
        return ApiResponse.ok(PushDeviceResponse.from(device));
    }

    @DeleteMapping("/{registrationId}")
    public ApiResponse<Void> unregister(@PathVariable String registrationId) {
        service.unregister(CurrentIdentity.require().accountId(), registrationId);
        return ApiResponse.ok();
    }

    @GetMapping
    public ApiResponse<List<PushDeviceResponse>> list() {
        return ApiResponse.ok(service.listMine(CurrentIdentity.require().accountId()).stream()
                .map(PushDeviceResponse::from)
                .toList());
    }
}
