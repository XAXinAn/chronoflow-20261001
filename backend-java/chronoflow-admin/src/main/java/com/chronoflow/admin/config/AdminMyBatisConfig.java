package com.chronoflow.admin.config;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.context.annotation.Configuration;

@Configuration
@MapperScan("com.chronoflow.admin.mapper")
public class AdminMyBatisConfig {
}
