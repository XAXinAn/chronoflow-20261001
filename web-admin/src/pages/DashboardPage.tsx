import { Alert, Col, Row, Skeleton } from 'antd';

import { api } from '../api';
import { useLoad } from '../hooks/useLoad';

const METRICS: Array<{ key: string; label: string }> = [
  { key: 'organizationCount', label: '组织总数' },
  { key: 'activeOrganizationCount', label: '启用中的组织' },
  { key: 'accountCount', label: '账号总数' },
  { key: 'disabledAccountCount', label: '已封禁账号' },
  { key: 'orgMemberCount', label: '在册组织成员' },
  { key: 'personalEventCount', label: '个人日程' },
  { key: 'taskCount', label: '待办总数' },
  { key: 'completedTaskCount', label: '已完成待办' },
  { key: 'dispatchCount', label: '组织日程下发次数' },
  { key: 'receiptCount', label: '回执记录数' },
  { key: 'pendingReceiptCount', label: '待回执' },
];

const formatter = new Intl.NumberFormat('zh-CN');

export function DashboardPage() {
  const { data, loading, error } = useLoad(() => api.dashboard());

  return (
    <div className="xa-page">
      <h2 className="xa-page-title">数据看板</h2>
      {error ? <Alert type="error" showIcon message={error.message} style={{ marginBottom: 16 }} /> : null}
      {loading || !data ? (
        <Skeleton active />
      ) : (
        <Row gutter={[16, 16]}>
          {METRICS.map((metric) => (
            <Col key={metric.key} xs={24} sm={12} lg={8} xl={6}>
              <div className="xa-card xa-card--hoverable">
                <div className="xa-metric-value">
                  {formatter.format((data as unknown as Record<string, number>)[metric.key] ?? 0)}
                </div>
                <div className="xa-metric-label">{metric.label}</div>
              </div>
            </Col>
          ))}
        </Row>
      )}
    </div>
  );
}
