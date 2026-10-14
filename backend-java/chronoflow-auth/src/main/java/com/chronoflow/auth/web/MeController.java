package com.chronoflow.auth.web;

import com.chronoflow.auth.dto.AuthDtos.DeviceResponse;
import com.chronoflow.auth.dto.AuthDtos.SendSmsCodeResponse;
import com.chronoflow.auth.dto.AuthDtos.NotificationPrefsRequest;
import com.chronoflow.auth.dto.AuthDtos.SetPasswordRequest;
import com.chronoflow.auth.dto.AuthDtos.UpdateProfileRequest;
import com.chronoflow.auth.dto.AccountSecurityDtos.AccountSecurityView;
import com.chronoflow.auth.dto.AccountSecurityDtos.BindEmailRequest;
import com.chronoflow.auth.dto.AccountSecurityDtos.ChangePhoneRequest;
import com.chronoflow.auth.dto.AccountSecurityDtos.EmailCodeResponse;
import com.chronoflow.auth.dto.AccountSecurityDtos.RealNameInitResponse;
import com.chronoflow.auth.dto.AccountSecurityDtos.RealNameRequest;
import com.chronoflow.auth.dto.AccountSecurityDtos.RealNameResultResponse;
import com.chronoflow.auth.dto.AccountSecurityDtos.SendEmailCodeRequest;
import com.chronoflow.auth.dto.AccountSecurityDtos.SendPhoneCodeRequest;
import com.chronoflow.auth.dto.IdentityView;
import com.chronoflow.auth.security.CurrentIdentity;
import com.chronoflow.auth.security.IdentityPrincipal;
import com.chronoflow.auth.service.AccountService;
import com.chronoflow.auth.service.AccountSecurityService;
import com.chronoflow.auth.service.AuthService;
import com.chronoflow.auth.service.EmailCodeService;
import com.chronoflow.auth.service.RealNameService;
import com.chronoflow.auth.service.VerificationCodeService;
import com.chronoflow.common.api.ApiResponse;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 账号设置，对应 spec §6.2「账号设置」分组。
 *
 * <p>所有操作都作用于**当前身份所属的账号**，账号与身份从令牌解析，不接受请求体传参。
 */
@RestController
@RequestMapping("/api/v1/me")
@SecurityRequirement(name = "bearerAuth")
public class MeController {

    private final AuthService authService;
    private final AccountService accountService;
    private final AccountSecurityService accountSecurity;
    private final EmailCodeService emailCodeService;
    private final RealNameService realNameService;
    private final VerificationCodeService smsCodeService;

    public MeController(AuthService authService,
                        AccountService accountService,
                        AccountSecurityService accountSecurity,
                        EmailCodeService emailCodeService,
                        RealNameService realNameService,
                        VerificationCodeService smsCodeService) {
        this.authService = authService;
        this.accountService = accountService;
        this.accountSecurity = accountSecurity;
        this.emailCodeService = emailCodeService;
        this.realNameService = realNameService;
        this.smsCodeService = smsCodeService;
    }

    // ------------------------------------------------------------ 账号与安全（spec §6.2）

    /** 实名与邮箱的当前状态。「我的 → 账号与安全」进来先调它。 */
    @GetMapping("/security")
    public ApiResponse<AccountSecurityView> security() {
        return ApiResponse.ok(accountSecurity.view(CurrentIdentity.require().accountId()));
    }

    /** 给要绑定的邮箱发验证码（阿里云 DirectMail）。 */
    @PostMapping("/email/code")
    public ApiResponse<EmailCodeResponse> sendEmailCode(@Valid @RequestBody SendEmailCodeRequest request) {
        EmailCodeService.SendResult result =
                emailCodeService.send(normalizeEmail(request.email()), EmailCodeService.Scene.BIND);
        return ApiResponse.ok(new EmailCodeResponse(result.expiresIn(), result.debugCode()));
    }

    /**
     * 换绑手机号第一步：给**指定号码**发验证码。
     *
     * <p>发码本身不泄露信息（码只发到那个号码），所以旧号与新号都允许调用；
     * 频控、日限额由 {@code VerificationCodeService} 统一管着（与登录发码同一套规则）。
     */
    @PostMapping("/phone/code")
    public ApiResponse<EmailCodeResponse> sendPhoneCode(@Valid @RequestBody SendPhoneCodeRequest request) {
        SendSmsCodeResponse result = smsCodeService.send(request.phone().trim(), null);
        return ApiResponse.ok(new EmailCodeResponse(result.expiresIn(), result.debugCode()));
    }

    /**
     * 旧手机号不能用时的替代验证：给**当前账号已绑定的邮箱**发码。
     *
     * <p>邮箱只从库里取，不接受客户端传参；没绑定邮箱就如实让用户先去绑定。
     */
    @PostMapping("/phone/email-code")
    public ApiResponse<EmailCodeResponse> sendPhoneChangeEmailCode() {
        IdentityPrincipal principal = CurrentIdentity.require();
        AccountSecurityView view = accountSecurity.view(principal.accountId());
        if (!view.emailVerified() || view.email() == null || view.email().isBlank()) {
            throw BizException.of(ErrorCode.PARAM_INVALID,
                    "账号还没有绑定邮箱，请先绑定邮箱后再用这种方式换号");
        }
        EmailCodeService.SendResult result =
                emailCodeService.send(view.email(), EmailCodeService.Scene.PHONE_CHANGE);
        return ApiResponse.ok(new EmailCodeResponse(result.expiresIn(), result.debugCode()));
    }

    /**
     * 换绑手机号第二步：新号验证码必验，「本人验证」用旧号验证码或邮箱验证码（二选一）。
     *
     * <p>为什么要证明本人：只验新号的话，任何拿到 access token 的人都能把手机号换成自己的，
     * 等于把账号偷走。旧号还在用就发旧号；旧号丢了就用已绑定邮箱——两者**恰好给一个**，
     * 都给或都不给都拒绝，避免出现「验了哪个」含糊不清的中间态。
     */
    @PostMapping("/phone")
    public ApiResponse<AccountSecurityView> changePhone(@Valid @RequestBody ChangePhoneRequest request) {
        IdentityPrincipal principal = CurrentIdentity.require();
        AccountSecurityView view = accountSecurity.view(principal.accountId());
        boolean hasOldCode = hasText(request.oldCode());
        boolean hasEmailCode = hasText(request.emailCode());
        if (hasOldCode == hasEmailCode) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "请提供旧手机号验证码或邮箱验证码（二选一）");
        }
        if (hasEmailCode) {
            if (!view.emailVerified() || view.email() == null || view.email().isBlank()) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "账号还没有绑定邮箱，无法用邮箱验证");
            }
            emailCodeService.verify(view.email(), EmailCodeService.Scene.PHONE_CHANGE, request.emailCode());
        } else {
            smsCodeService.verify(view.phone(), request.oldCode());
        }
        smsCodeService.verify(request.newPhone().trim(), request.newCode());
        return ApiResponse.ok(accountSecurity.changePhone(principal.accountId(), request.newPhone()));
    }

    /** 绑定 / 改绑邮箱：验证码校验通过才写库（邮箱在库里唯一）。 */
    @PostMapping("/email")
    public ApiResponse<AccountSecurityView> bindEmail(@Valid @RequestBody BindEmailRequest request) {
        String email = normalizeEmail(request.email());
        emailCodeService.verify(email, EmailCodeService.Scene.BIND, request.code());
        return ApiResponse.ok(accountSecurity.bindEmail(CurrentIdentity.require().accountId(), email));
    }

    /** 发起实名认证：返回 CloudAuth 的认证页地址，App 用 WebView 打开。 */
    @PostMapping("/realname")
    public ApiResponse<RealNameInitResponse> initRealName(@Valid @RequestBody RealNameRequest request) {
        IdentityPrincipal principal = CurrentIdentity.require();
        return ApiResponse.ok(realNameService.init(principal.accountId(), request.realName(), request.idCardNumber(), request.metaInfo()));
    }

    /** 人脸做完后回查结果；通过才把实名写进账号。 */
    @GetMapping("/realname/result")
    public ApiResponse<RealNameResultResponse> realNameResult(@RequestParam String certifyId) {
        return ApiResponse.ok(realNameService.result(CurrentIdentity.require().accountId(), certifyId));
    }

    /** 邮箱统一小写去空格：验证码按邮箱存、绑定也按邮箱查，两处不一致就会出现「码对了却绑不上」。 */
    private String normalizeEmail(String email) {
        return email.trim().toLowerCase();
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    @GetMapping
    public ApiResponse<IdentityView> me() {
        IdentityPrincipal principal = CurrentIdentity.require();
        return ApiResponse.ok(authService.currentIdentityView(principal.accountId(), principal.identityId()));
    }

    @PatchMapping
    public ApiResponse<IdentityView> updateProfile(@Valid @RequestBody UpdateProfileRequest request) {
        IdentityPrincipal principal = CurrentIdentity.require();
        accountService.updateProfile(principal.identityId(), request);
        return ApiResponse.ok(authService.currentIdentityView(principal.accountId(), principal.identityId()));
    }

    /**
     * 设置或修改密码。账号已有密码时必须提供原密码。
     */
    @PutMapping("/password")
    public ApiResponse<Void> setPassword(@Valid @RequestBody SetPasswordRequest request) {
        IdentityPrincipal principal = CurrentIdentity.require();
        accountService.setPassword(principal.accountId(), request);
        return ApiResponse.ok();
    }

    @GetMapping("/devices")
    public ApiResponse<List<DeviceResponse>> devices() {
        IdentityPrincipal principal = CurrentIdentity.require();
        return ApiResponse.ok(accountService.devices(principal.identityId()));
    }

    @DeleteMapping("/devices/{deviceId}")
    public ApiResponse<Void> revokeDevice(@PathVariable String deviceId) {
        IdentityPrincipal principal = CurrentIdentity.require();
        accountService.revokeDevice(principal.identityId(), deviceId);
        return ApiResponse.ok();
    }

    @PutMapping("/notifications")
    public ApiResponse<Map<String, Boolean>> updateNotifications(
            @Valid @RequestBody NotificationPrefsRequest request) {
        IdentityPrincipal principal = CurrentIdentity.require();
        return ApiResponse.ok(accountService.updateNotificationPrefs(principal.identityId(), request.prefs()));
    }

    /**
     * 自助注销账号（商店规范 §2.7：App 内必须有对应的注销功能按钮）。
     *
     * <p>注销后本设备与所有其他设备的令牌同时失效，App 侧调完这个接口必须清掉本地会话。
     * 这里用 POST 而不是 DELETE：它不是「删掉一个资源」，而是一次不可逆的账号处置动作，
     * 与 {@code /admin/accounts/{id}/status} 保持同一风格。
     */
    @PostMapping("/deletion")
    public ApiResponse<Void> deleteAccount() {
        IdentityPrincipal principal = CurrentIdentity.require();
        accountService.deleteAccount(principal.accountId());
        return ApiResponse.ok();
    }
}
