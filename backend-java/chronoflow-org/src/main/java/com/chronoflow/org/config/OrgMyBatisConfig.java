package com.chronoflow.org.config;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.context.annotation.Configuration;

@Configuration
@MapperScan("com.chronoflow.org.mapper")
public class OrgMyBatisConfig {
}
