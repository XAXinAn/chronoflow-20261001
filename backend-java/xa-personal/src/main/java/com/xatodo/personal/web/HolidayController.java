package com.xatodo.personal.web;

import com.xatodo.common.api.ApiResponse;
import com.xatodo.personal.dto.HolidayDtos.HolidayResponse;
import com.xatodo.personal.service.HolidayService;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 节假日与调休（spec §5.11 / §6.2）。
 *
 * <p>数据由 {@code scripts/load_holidays.py} 灌入，这里只读 + 缓存。
 */
@RestController
@RequestMapping("/api/v1/holidays")
@SecurityRequirement(name = "bearerAuth")
public class HolidayController {

    private final HolidayService holidayService;

    public HolidayController(HolidayService holidayService) {
        this.holidayService = holidayService;
    }

    /** @param month 省略时返回全年 */
    @GetMapping
    public ApiResponse<HolidayResponse> list(@RequestParam Integer year,
                                             @RequestParam(required = false) Integer month,
                                             @RequestParam(required = false) String country) {
        return ApiResponse.ok(holidayService.query(country, year, month));
    }
}
