package com.xatodo.personal.holiday;

/**
 * 节假日上游数据源。
 *
 * <p>抽成接口是为了两件事：定时同步能注入假的上游做测试（测试不该依赖外网），
 * 以及将来换数据源（自建镜像、企业内网）时只换实现。
 */
public interface HolidaySource {

    /**
     * 取某一年上游 JSON 原文。
     *
     * @return 原文；该年数据**尚未发布**时返回 null（这是正常情况，不是错误——
     *         次年的放假安排通常要等到当年 11 月才有）
     */
    String fetch(int year) throws Exception;
}
