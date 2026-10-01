package com.chronoflow.personal.config;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.context.annotation.Configuration;

@Configuration
@MapperScan("com.chronoflow.personal.mapper")
public class PersonalMyBatisConfig {
}
