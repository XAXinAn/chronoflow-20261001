package com.xatodo.support.config;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.context.annotation.Configuration;

@Configuration
@MapperScan("com.xatodo.support.mapper")
public class SupportMyBatisConfig {
}
