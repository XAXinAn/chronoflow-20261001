import { Alert, Button, Empty, Table, Tag } from 'antd';

import { api } from '../api';
import type { AuditLog } from '../api/types';
import { useLoad } from '../hooks/useLoad';

/**
 * 本组织的操作日志（spec §4.3）。
 *
 * 数据来自后端写入 `audit_log` 的真实管理动作：建/改成员、导入、部门调整、组织日程下发与撤回、
 * 组织设置变更都在里面（`actorType=ADMIN` 是后台管理端，`ACCOUNT` 是 App 里的组织身份）。
 */
export function OrgLogsPage() {
  const { data, loading, error, reload } = useLoad<AuditLog[]>(() => api.orgLogs({ limit: 200 }));

  return (
    <div className="xa-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="xa-page-title">操作日志</h2>
        <Button onClick={() => void reload()}>刷新</Button>
      </div>
      {error ? <Alert type="error" showIcon message={error.message} style={{ marginBottom: 16 }} /> : null}

      <Table<AuditLog>
        rowKey="id"
        loading={loading}
        dataSource={data ?? []}
        locale={{ emptyText: <Empty description="还没有管理操作记录" /> }}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: '时间', dataIndex: 'createdAt', width: 200 },
          {
            title: '操作人',
            width: 160,
            render: (_, record) => (
              <span>
                {record.actorName ?? '—'}{' '}
                <Tag bordered={false}>{record.actorType === 'ADMIN' ? '后台' : 'App'}</Tag>
              </span>
            ),
          },
          { title: '动作', dataIndex: 'action', width: 220 },
          { title: '对象', dataIndex: 'targetType', width: 140 },
          { title: '对象 ID', dataIndex: 'targetId', width: 100 },
          { title: '详情', dataIndex: 'detail', ellipsis: true },
        ]}
      />
    </div>
  );
}
