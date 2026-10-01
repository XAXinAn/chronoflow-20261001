package com.chronoflow.auth.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.chronoflow.auth.dto.IdentityView;
import com.chronoflow.auth.entity.Identity;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;

@Mapper
public interface IdentityMapper extends BaseMapper<Identity> {

    /**
     * 查询账号下的全部可用身份，并附带组织 / 部门 / 工号信息，用于登录后的身份选择页。
     */
    List<IdentityView> selectIdentityViews(@Param("accountId") Long accountId);
}
