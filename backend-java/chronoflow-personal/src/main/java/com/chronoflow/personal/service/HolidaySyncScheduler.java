package com.chronoflow.personal.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;

/**
 * 节假日自动同步的调度器（spec §5.11）。
 *
 * <p>两条触发：每天固定时刻一次；启动后延迟一小会儿再跑一次（新部署 / 重建库后不必等到凌晨，
 * 也不占用启动线程）。用 {@code chronoflow.holiday.sync.enabled=false} 整体关掉——
 * 测试就是这么关的：单元测试不该依赖外网。
 */
@Component
@ConditionalOnProperty(prefix = "chronoflow.holiday.sync", name = "enabled", havingValue = "true", matchIfMissing = true)
public class HolidaySyncScheduler {

    private static final Logger log = LoggerFactory.getLogger(HolidaySyncScheduler.class);

    private final HolidaySyncService syncService;
    private final TaskScheduler taskScheduler;
    private final boolean runOnStartup;
    private final Duration startupDelay;

    public HolidaySyncScheduler(HolidaySyncService syncService,
                                TaskScheduler taskScheduler,
                                @Value("${chronoflow.holiday.sync.run-on-startup:true}") boolean runOnStartup,
                                @Value("${chronoflow.holiday.sync.startup-delay:30s}") Duration startupDelay) {
        this.syncService = syncService;
        this.taskScheduler = taskScheduler;
        this.runOnStartup = runOnStartup;
        this.startupDelay = startupDelay;
    }

    @Scheduled(cron = "${chronoflow.holiday.sync.cron:0 10 3 * * *}",
            zone = "${chronoflow.holiday.sync.zone:Asia/Shanghai}")
    public void daily() {
        syncService.syncOnce();
    }

    @EventListener(ApplicationReadyEvent.class)
    public void scheduleStartupRun() {
        if (!runOnStartup) {
            return;
        }
        // 交给 Spring 的调度线程池：不占启动线程，也不占请求线程
        taskScheduler.schedule(syncService::syncOnce, Instant.now().plus(startupDelay));
        log.info("节假日同步已排定：启动后 {} 再跑一次", startupDelay);
    }
}
