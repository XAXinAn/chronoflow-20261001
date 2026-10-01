import { describe, expect, it } from 'vitest';

import {
  MAX_NICKNAME_LENGTH,
  displayName,
  normalizeNickname,
  validateNickname,
} from '../src/domain/profile';

describe('昵称的规整与校验', () => {
  it('去掉首尾空白，内部的换行/连续空白折成一个空格', () => {
    expect(normalizeNickname('  小明  ')).toBe('小明');
    expect(normalizeNickname('张\n三')).toBe('张 三');
    expect(normalizeNickname('a\t\tb')).toBe('a b');
  });

  it('空白名字不接受', () => {
    expect(validateNickname('')).toBe('名字不能为空');
    expect(validateNickname('   ')).toBe('名字不能为空');
    expect(validateNickname('\n')).toBe('名字不能为空');
  });

  it('长度上限与服务端一致（32），且按码点算——emoji 不会被当成两个字', () => {
    expect(MAX_NICKNAME_LENGTH).toBe(32);
    expect(validateNickname('啊'.repeat(32))).toBeNull();
    expect(validateNickname('啊'.repeat(33))).toBe('名字最多 32 个字');
    // 32 个 emoji：UTF-16 长度是 64，按码点算才不误判
    expect(validateNickname('🙂'.repeat(32))).toBeNull();
    expect(validateNickname('🙂'.repeat(33))).toBe('名字最多 32 个字');
    // 首尾空白不算长度
    expect(validateNickname(`  ${'啊'.repeat(32)}  `)).toBeNull();
  });

  it('中英文与符号都允许（名字不是实名字段）', () => {
    expect(validateNickname('Xiao Ming')).toBeNull();
    expect(validateNickname('小安·测试')).toBeNull();
  });

  it('显示用的名字：null / 空白都回「未命名」', () => {
    expect(displayName(null)).toBe('未命名');
    expect(displayName('  ')).toBe('未命名');
    expect(displayName(' 小明 ')).toBe('小明');
  });
});
