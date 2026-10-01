import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REC_CLASSES, buildCharacterList } from '../src/vision/ppocr/charset';

const DICT_PATH = join(__dirname, '..', 'assets', 'models', 'ppocr', 'ppocr_keys_v1.txt');

describe('PP-OCR 的字符表', () => {
  it('下标 0 是 blank，末尾补一个空格（官方的 use_space_char）', () => {
    const list = buildCharacterList('珠\n络\n诺', 5);
    expect(list).toEqual(['', '珠', '络', '诺', ' ']);
    expect(list[0]).toBe('');
    expect(list[list.length - 1]).toBe(' ');
  });

  it('模型类别数正好等于「字典 + blank」时不补空格（转换版之间的差异）', () => {
    expect(buildCharacterList('珠\n络\n诺', 4)).toEqual(['', '珠', '络', '诺']);
  });

  it('不给类别数时按官方约定补空格（离线脚本 / 单测用）', () => {
    expect(buildCharacterList('甲\n乙')).toEqual(['', '甲', '乙', ' ']);
  });

  it('字典与模型对不上就当场抛错，不悄悄错位', () => {
    expect(() => buildCharacterList('甲\n乙', 99)).toThrow(/字符表与模型对不上/);
    expect(() => buildCharacterList('', 5)).toThrow(/字符表是空的/);
  });

  it('只去换行符：CRLF 与空行都要能正确读进来', () => {
    // 不 trim 每行是刻意的：某些字典里有以空格为内容的字
    expect(buildCharacterList('甲\r\n\r\n乙\n ')).toEqual(['', '甲', '乙', ' ', ' ']);
  });

  it('真实的字典文件（拉了模型才有）与模型类别数一致', () => {
    // 字典不进版本库（见 .gitignore），没拉过模型就跳过这一条
    const hasDict = existsSync(DICT_PATH);
    if (!hasDict) {
      return;
    }
    const list = buildCharacterList(readFileSync(DICT_PATH, 'utf8'), REC_CLASSES);
    expect(list.length).toBe(REC_CLASSES);
    expect(list[0]).toBe('');
    expect(list[REC_CLASSES - 1]).toBe(' ');
    // 头几个字是字典的开头（离线比对过与模型元数据里的 character 逐条相同）
    expect(list[1]).toBe("'");
    expect(list[2]).toBe('疗');
  });
});
