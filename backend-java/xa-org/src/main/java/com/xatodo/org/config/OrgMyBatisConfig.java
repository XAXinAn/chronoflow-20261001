package com.xatodo.org.config;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.context.annotation.Configuration;

@Configuration
@MapperScan("com.xatodo.org.mapper")
public class OrgMyBatisConfig {
}
