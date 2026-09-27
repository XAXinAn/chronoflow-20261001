package com.xatodo.support.dto;

import com.xatodo.support.entity.PushDevice;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.time.OffsetDateTime;

public final class PushDtos {

    private PushDtos() {
    }

    /** registrationId 来自极光 SDK；platform 只允许 android / ios。 */
    public record PushDeviceRequest(
            @NotBlank(message = "registrationId 不能为空")
            @Size(max = 128, message = "registrationId 过长")
            String registrationId,
            String platform,
            @Size(max = 32) String appVersion) {
    }

    public record PushDeviceResponse(Long id, String provider, String registrationId,
                                     String platform, String appVersion,
                                     OffsetDateTime createdAt, OffsetDateTime updatedAt) {

        public static PushDeviceResponse from(PushDevice device) {
            return new PushDeviceResponse(device.getId(), device.getProvider(), device.getRegistrationId(),
                    device.getPlatform(), device.getAppVersion(), device.getCreatedAt(), device.getUpdatedAt());
        }
    }
}
