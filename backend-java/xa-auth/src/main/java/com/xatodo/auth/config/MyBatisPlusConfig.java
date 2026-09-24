package com.xatodo.auth.config;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.context.annotation.Configuration;

/**
 * MyBatis-Plus Mapper 扫描。后续领域模块各自声明自己的 mapper 包。
 */
@Configuration
@MapperScan("com.xatodo.auth.mapper")
public class MyBatisPlusConfig {
}
