package com.chronoflow.org.web;

import com.chronoflow.auth.security.CurrentIdentity;
import com.chronoflow.auth.security.IdentityPrincipal;
import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.org.dto.OrgDtos.OrgAccountLinkRequest;
import com.chronoflow.org.dto.OrgDtos.OrgAccountResponse;
import com.chronoflow.org.service.OrgAccountService;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 组织账号的绑定与解绑（spec §3.2 / §4.2.5）。
 *
 * <p>全部用**个人身份**的令牌调用：管理的是「我这个个人账号绑定了哪些组织账号」。
 * 组织身份的数据接口在 `/org/**`，用组织身份的令牌。
 */
@RestController
@RequestMapping("/api/v1/org-accounts")
@SecurityRequirement(name = "bearerAuth")
public class OrgAccountController {

    private final OrgAccountService orgAccountService;

    public OrgAccountController(OrgAccountService orgAccountService) {
        this.orgAccountService = orgAccountService;
    }

    /** 登录组织账号并绑定；返回该组织身份的令牌对，App 存进组织账号列表。 */
    @PostMapping("/login")
    public ApiResponse<OrgAccountService.LoginResult> login(
            @Valid @RequestBody OrgAccountLinkRequest request,
            @RequestParam String deviceId) {
        IdentityPrincipal principal = CurrentIdentity.require();
        orgAccountService.requirePersonal(principal);
        return ApiResponse.ok(orgAccountService.login(
                principal.accountId(), request.org(), request.memberKey(), deviceId));
    }

    @GetMapping
    public ApiResponse<List<OrgAccountResponse>> list() {
        IdentityPrincipal principal = CurrentIdentity.require();
        orgAccountService.requirePersonal(principal);
        return ApiResponse.ok(orgAccountService.list(principal.accountId()));
    }

    /** 解绑：删除这台账号上的登录记录（组织侧成员记录保留，可重新认领）。 */
    @DeleteMapping("/{identityId}")
    public ApiResponse<Void> unlink(@PathVariable Long identityId) {
        IdentityPrincipal principal = CurrentIdentity.require();
        orgAccountService.requirePersonal(principal);
        orgAccountService.unlink(principal.accountId(), identityId);
        return ApiResponse.ok();
    }
}
