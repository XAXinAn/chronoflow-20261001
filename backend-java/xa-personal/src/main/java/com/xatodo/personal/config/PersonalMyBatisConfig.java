package com.xatodo.personal.config;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.context.annotation.Configuration;

@Configuration
@MapperScan("com.xatodo.personal.mapper")
public class PersonalMyBatisConfig {
}
