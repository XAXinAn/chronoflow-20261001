package com.xatodo.personal.dto;

import java.time.LocalDate;
import java.util.List;

/**
 * 节假日与调休（spec §5.11）。
 */
public final class HolidayDtos {

    private HolidayDtos() {
    }

    /** @param dayType `HOLIDAY`（放假）/ `WORKDAY`（调休上班） */
    public record HolidayItem(LocalDate date, String name, String dayType) {
    }

    /** @param month 省略 month 时返回全年，此时该字段为 null */
    public record HolidayResponse(String country, int year, Integer month, List<HolidayItem> days) {
    }
}
