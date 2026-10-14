import { useEffect, useState } from 'react';

import type { Endpoints } from '../api/endpoints';
import { parseFeatureFlags, type FeatureFlags, DEFAULT_FEATURE_FLAGS } from '../domain/features';
import { useRuntime } from './AppContext';

/**
 * 功能开关的进程内缓存。
 *
 * <p>为什么需要缓存：同一屏里「我的」页、底部导航都要读它，各自发一次请求既浪费
 * 也可能出现「一个入口没了、另一个还在」的瞬间不一致。这里做三件事：
 * 共享结果、合并并发请求、失败时保留上一次的值（绝不因为一次网络抖动把入口藏起来）。
 */
let cached: FeatureFlags = DEFAULT_FEATURE_FLAGS;
let inflight: Promise<FeatureFlags> | null = null;

export function currentFeatureFlags(): FeatureFlags {
  return cached;
}

export async function loadFeatureFlags(api: Endpoints): Promise<FeatureFlags> {
  if (inflight) {
    return inflight;
  }
  inflight = api
    .systemFeatures()
    .then((raw) => {
      cached = parseFeatureFlags(raw);
      return cached;
    })
    .catch(() => cached)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 组件里读功能开关：先用缓存渲染，再异步拉一次最新的。 */
export function useFeatureFlags(): FeatureFlags {
  const { api } = useRuntime();
  const [flags, setFlags] = useState<FeatureFlags>(currentFeatureFlags);
  useEffect(() => {
    let alive = true;
    void loadFeatureFlags(api).then((next) => {
      if (alive) {
        setFlags(next);
      }
    });
    return () => {
      alive = false;
    };
  }, [api]);
  return flags;
}
