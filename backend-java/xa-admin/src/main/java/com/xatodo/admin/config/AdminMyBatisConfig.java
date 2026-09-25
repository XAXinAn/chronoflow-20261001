package com.xatodo.admin.config;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.context.annotation.Configuration;

@Configuration
@MapperScan("com.xatodo.admin.mapper")
public class AdminMyBatisConfig {
}
