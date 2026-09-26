import { App as AntdApp, Alert, Button, Image, Segmented, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';

import { api, resolveApiAssetUrl } from '../api';
import type { Feedback } from '../api/types';
import { useLoad } from '../hooks/useLoad';

const CATEGORY_LABEL: Record<string, string> = {
  BUG: '功能异常',
  SUGGESTION: '体验建议',
  OTHER: '其他',
};

/**
 * 意见反馈查阅（spec §4.1.9 / §4.4）。仅平台超管可见。
 *
 * 默认只看待处理的：超管打开这个页面是来干活的，不是来翻历史的（与后端默认口径一致）。
 */
export function FeedbackPage() {
  const { message } = AntdApp.useApp();
  const [status, setStatus] = useState<'OPEN' | 'HANDLED' | 'ALL'>('OPEN');
  const feedbacks = useLoad<Feedback[]>(
    () => api.feedbacks(status === 'ALL' ? {} : { status }),
    [status],
  );

  return (
    <div className="xa-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="xa-page-title">意见反馈</h2>
        <Space>
          <Segmented
            value={status}
            onChange={(value) => setStatus(value as typeof status)}
            options={[
              { label: '待处理', value: 'OPEN' },
              { label: '已处理', value: 'HANDLED' },
              { label: '全部', value: 'ALL' },
            ]}
          />
          <Button onClick={() => void feedbacks.reload()}>刷新</Button>
        </Space>
      </div>

      {feedbacks.error ? (
        <Alert type="error" showIcon message={feedbacks.error.message} style={{ marginBottom: 16 }} />
      ) : null}

      <Table<Feedback>
        rowKey="id"
        loading={feedbacks.loading}
        dataSource={feedbacks.data ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: '提交时间', dataIndex: 'createdAt', width: 200 },
          {
            title: '分类',
            dataIndex: 'category',
            width: 110,
            render: (value: string) => <Tag bordered={false}>{CATEGORY_LABEL[value] ?? value}</Tag>,
          },
          {
            title: '内容',
            dataIndex: 'content',
            render: (value: string, record) => (
              <Space direction="vertical" size={4}>
                <Typography.Text>{value}</Typography.Text>
                {record.images?.length ? (
                  <Image.PreviewGroup>
                    {(record.images ?? []).map((url) => (
                      <Image
                        key={url}
                        src={resolveApiAssetUrl(url)}
                        width={72}
                        height={72}
                        style={{ objectFit: 'cover', borderRadius: 8 }}
                      />
                    ))}
                  </Image.PreviewGroup>
                ) : null}
              </Space>
            ),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 110,
            render: (value: string) =>
              value === 'HANDLED' ? (
                <Tag bordered={false}>已处理</Tag>
              ) : (
                <Tag bordered={false} color="warning">
                  待处理
                </Tag>
              ),
          },
          {
            title: '操作',
            width: 120,
            render: (_, record) =>
              record.status === 'OPEN' ? (
                <Button
                  type="link"
                  size="small"
                  onClick={async () => {
                    try {
                      await api.handleFeedback(record.id);
                      message.success('已标记为处理完成');
                      await feedbacks.reload();
                    } catch (cause) {
                      message.error(cause instanceof Error ? cause.message : '处理失败');
                    }
                  }}
                >
                  标记已处理
                </Button>
              ) : (
                <span>—</span>
              ),
          },
        ]}
      />
    </div>
  );
}
