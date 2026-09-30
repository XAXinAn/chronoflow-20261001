import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgEventsPage } from '../src/pages/OrgEventsPage';
import type { OrgEventItem } from '../src/api/types';

const eventsMock = vi.fn();
const departmentsMock = vi.fn();
const membersMock = vi.fn();

vi.mock('../src/api', () => ({
  api: {
    orgEvents: (...args: unknown[]) => eventsMock(...args),
    orgDepartments: () => departmentsMock(),
    orgMembers: () => membersMock(),
    revokeOrgEvent: () => Promise.resolve(),
    deleteOrgEvent: () => Promise.resolve(),
    dispatchOrgEvent: () => Promise.resolve(),
  },
  resolveApiAssetUrl: (path: string) => path,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function item(overrides: Partial<OrgEventItem>): OrgEventItem {
  return {
    eventId: 1,
    dispatchId: 11,
    title: '组内同步',
    at: '2026-10-08T09:00:00+08:00',
    timezone: 'Asia/Shanghai',
    scopeType: 'ALL',
    recipientCount: 3,
    status: 'ACTIVE',
    canEdit: true,
    ...overrides,
  };
}

function renderPage(rows: OrgEventItem[]) {
  eventsMock.mockResolvedValue(rows);
  departmentsMock.mockResolvedValue([]);
  membersMock.mockResolvedValue([]);
  render(
    <MemoryRouter>
      <AntdApp>
        <OrgEventsPage />
      </AntdApp>
    </MemoryRouter>,
  );
}

describe('组织日历管理页', () => {
  it('只有发起人能看到「撤回 / 删除」按钮', async () => {
    renderPage([
      item({ eventId: 1, title: '我发的会', canEdit: true }),
      item({ eventId: 2, title: '别人发的会', canEdit: false }),
    ]);

    expect(await screen.findByText('我发的会')).toBeInTheDocument();
    expect(screen.getByText('别人发的会')).toBeInTheDocument();

    // 非发起人那行给出的是说明文字，而不是点下去必收 20003 的按钮
    expect(screen.getByText('仅发起人可操作')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '撤回' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1);
    expect(screen.getAllByText('生效中')).toHaveLength(2);
  });

  it('已撤回的条目显示状态且不再给操作按钮', async () => {
    renderPage([item({ eventId: 3, title: '撤回过的会', status: 'REVOKED', canEdit: true })]);

    expect(await screen.findByText('撤回过的会')).toBeInTheDocument();
    expect(screen.getByText('已撤回')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '撤回' })).toBeNull();
    expect(screen.queryByText('生效中')).toBeNull();
  });

  it('默认只看生效中的，打开「含已撤回」后带 includeRevoked=true 重新拉列表', async () => {
    renderPage([item({})]);

    expect(await screen.findByText('组内同步')).toBeInTheDocument();
    expect(eventsMock).toHaveBeenCalledTimes(1);
    expect(eventsMock.mock.calls[0][2]).toBe(false);

    fireEvent.click(screen.getByRole('switch'));

    await vi.waitFor(() => expect(eventsMock).toHaveBeenCalledTimes(2));
    expect(eventsMock.mock.calls[1][2]).toBe(true);
  });
});
