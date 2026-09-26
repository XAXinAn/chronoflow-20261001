import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntdApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeedbackPage } from '../src/pages/FeedbackPage';

const feedbacksMock = vi.fn();
const handleMock = vi.fn();

vi.mock('../src/api', () => ({
  api: {
    feedbacks: (...args: unknown[]) => feedbacksMock(...args),
    handleFeedback: (...args: unknown[]) => handleMock(...args),
  },
  resolveApiAssetUrl: (path: string) => `http://localhost:8080${path}`,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <AntdApp>
        <FeedbackPage />
      </AntdApp>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('意见反馈页', () => {
  it('默认只看待处理的反馈', async () => {
    feedbacksMock.mockResolvedValue([
      {
        id: 1,
        category: 'BUG',
        content: '日历页滑动会卡一下',
        images: [],
        status: 'OPEN',
        createdAt: '2026-09-25T10:00:00Z',
      },
    ]);

    renderPage();

    expect(await screen.findByText('日历页滑动会卡一下')).toBeInTheDocument();
    expect(feedbacksMock).toHaveBeenCalledWith({ status: 'OPEN' });
  });

  it('标记已处理后刷新列表', async () => {
    feedbacksMock.mockResolvedValue([
      {
        id: 7,
        category: 'SUGGESTION',
        content: '希望支持导出',
        images: [],
        status: 'OPEN',
        createdAt: '2026-09-25T10:00:00Z',
      },
    ]);
    handleMock.mockResolvedValue({ id: 7, status: 'HANDLED' });

    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /标记已处理/ }));

    await waitFor(() => expect(handleMock).toHaveBeenCalledWith(7));
    // 处理后要重新拉一次列表，否则页面还停在旧状态
    await waitFor(() => expect(feedbacksMock).toHaveBeenCalledTimes(2));
  });
});
