package com.chronoflow.auth.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.chronoflow.auth.entity.Account;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface AccountMapper extends BaseMapper<Account> {
}
