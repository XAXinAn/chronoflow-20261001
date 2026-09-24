package com.xatodo.bootstrap;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * XaTodo 后端启动入口。
 */
@SpringBootApplication(scanBasePackages = "com.xatodo")
public class XaTodoApplication {

    public static void main(String[] args) {
        SpringApplication.run(XaTodoApplication.class, args);
    }
}
