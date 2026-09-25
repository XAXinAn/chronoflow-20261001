package com.xatodo.personal.web;

import com.xatodo.auth.security.CurrentIdentity;
import com.xatodo.common.api.ApiResponse;
import com.xatodo.personal.dto.SearchDtos.SearchResultItem;
import com.xatodo.personal.service.SearchService;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 关键字检索（spec §4.1.7 / §6.2「检索」）。
 *
 * <p>日历页顶部的常驻搜索框用它跨日程与待办检索，**不受当前显示月份限制**。
 */
@RestController
@RequestMapping("/api/v1/search")
@SecurityRequirement(name = "bearerAuth")
public class SearchController {

    private final SearchService searchService;

    public SearchController(SearchService searchService) {
        this.searchService = searchService;
    }

    /**
     * @param types `EVENT` / `TASK`，可重复或逗号分隔；省略表示两者都搜
     * @param limit 省略默认 20，上限 50
     */
    @GetMapping
    public ApiResponse<List<SearchResultItem>> search(@RequestParam String keyword,
                                                      @RequestParam(required = false) List<String> types,
                                                      @RequestParam(required = false) Integer limit) {
        Long identityId = CurrentIdentity.require().identityId();
        return ApiResponse.ok(searchService.search(identityId, keyword, types, limit));
    }
}
