package com.chronoflow.personal.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * 打开定时任务支持。
 *
 * <p>只在这里开一次：@EnableScheduling 散落在多处会生成多个调度器，
 * 同一个任务被跑几遍这类问题很难看出来。
 */
@Configuration
@EnableScheduling
public class HolidaySyncConfig {
}
