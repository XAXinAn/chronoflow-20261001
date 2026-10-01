package com.chronoflow.bootstrap;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * ChronoFlow 后端启动入口。
 */
@SpringBootApplication(scanBasePackages = "com.chronoflow")
public class ChronoFlowApplication {

    public static void main(String[] args) {
        SpringApplication.run(ChronoFlowApplication.class, args);
    }
}
