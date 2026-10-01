package com.chronoflow.support.config;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.context.annotation.Configuration;

@Configuration
@MapperScan("com.chronoflow.support.mapper")
public class SupportMyBatisConfig {
}
