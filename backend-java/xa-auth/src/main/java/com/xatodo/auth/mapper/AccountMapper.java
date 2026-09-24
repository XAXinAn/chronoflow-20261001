package com.xatodo.auth.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.xatodo.auth.entity.Account;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface AccountMapper extends BaseMapper<Account> {
}
