import { describe, expect, it, vi } from 'vitest';

import { acquirePosition, type PositionSource } from '../src/location/acquirePosition';

const BEIJING = { latitude: 39.9087, longitude: 116.3975 };
const SHANGHAI = { latitude: 31.24, longitude: 121.49 };

function source(overrides: Partial<PositionSource> = {}): PositionSource {
  return {
    systemAvailable: () => true,
    fromSystem: vi.fn().mockResolvedValue(BEIJING),
    fromFallback: vi.fn().mockResolvedValue(SHANGHAI),
    ...overrides,
  };
}

describe('取当前位置的来源选择', () => {
  it('有系统定位模块时优先用它（华为等无 GMS 机型唯一的正解）', async () => {
    const position = await acquirePosition(source(), 8000);
    expect(position).toEqual(BEIJING);
  });

  it('没有系统定位模块（老 APK / iOS）时退回 expo-location', async () => {
    const fallback = vi.fn().mockResolvedValue(SHANGHAI);
    const position = await acquirePosition(
      source({ systemAvailable: () => false, fromFallback: fallback }),
      8000,
    );
    expect(position).toEqual(SHANGHAI);
    expect(fallback).toHaveBeenCalled();
  });

  it('系统定位失败时再给 expo 一次机会（有 GMS 的机器能拿到上次已知位置）', async () => {
    const position = await acquirePosition(
      source({ fromSystem: vi.fn().mockRejectedValue(new Error('定位服务未开启')) }),
      8000,
    );
    expect(position).toEqual(SHANGHAI);
  });

  it('两条来源都失败就如实抛错，绝不返回编造的坐标', async () => {
    const failure = new Error('系统定位服务未开启');
    await expect(
      acquirePosition(
        source({
          fromSystem: vi.fn().mockRejectedValue(failure),
          fromFallback: vi.fn().mockRejectedValue(new Error('expo-location 也不可用')),
        }),
        8000,
      ),
    ).rejects.toThrow('系统定位服务未开启');
  });
});
