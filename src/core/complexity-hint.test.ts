import { describe, it, expect } from 'vitest';
import { shouldSuggestDecomposition } from './complexity-hint.js';

describe('shouldSuggestDecomposition', () => {
  it('returns true for Chinese comparison of multiple products', () => {
    expect(shouldSuggestDecomposition('帮我对比 A、B、C 三个产品')).toBe(true);
  });

  it('returns false for simple creative request', () => {
    expect(shouldSuggestDecomposition('写一首诗')).toBe(false);
  });

  it('returns true for English research + comparison', () => {
    expect(shouldSuggestDecomposition('Research competitors X, Y, Z and write a comparison report')).toBe(true);
  });

  it('returns false for short messages', () => {
    expect(shouldSuggestDecomposition('Hello')).toBe(false);
  });

  it('returns true for Chinese research + report request', () => {
    expect(shouldSuggestDecomposition('帮我调研三个竞品然后写报告')).toBe(true);
  });

  it('returns false for simple bug fix', () => {
    expect(shouldSuggestDecomposition('Fix the bug in line 42')).toBe(false);
  });

  it('returns true for multiple + summarize pattern', () => {
    expect(shouldSuggestDecomposition('Compare multiple SaaS products and summarize findings')).toBe(true);
  });

  it('returns false for simple translation', () => {
    expect(shouldSuggestDecomposition('翻译这段话')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(shouldSuggestDecomposition('')).toBe(false);
  });

  it('returns true for analyze N files pattern', () => {
    expect(shouldSuggestDecomposition('Analyze these 5 files and then create separate test files for each')).toBe(true);
  });

  it('returns false for non-string input coerced to empty', () => {
    expect(shouldSuggestDecomposition(undefined as any)).toBe(false);
  });

  it('returns true for sequential multi-step with count', () => {
    expect(shouldSuggestDecomposition('调研这3个竞品然后写一份分析总结报告')).toBe(true);
  });

  // Regression: the real production prompt that slipped through — a task
  // explicitly organized into 阶段一/二/三 matched only ONE old signal
  // ("三个区域") and never got the decomposition hint. Phase markers must
  // short-circuit to true.
  it('returns true for a prompt explicitly organized into Chinese phases (production regression)', () => {
    const prompt = [
      '**任务：季度税务动态更新 —— 分析框架模板 + 内容初版 + 提交**',
      '**背景** 面向本公司的 Q2 2026 税务动态汇编，覆盖三个区域。',
      '**阶段一：构建分析框架模板** 工具：Python + openpyxl。',
      '**阶段二：填充内容初版** 按区域、按国家逐条录入。',
      '**阶段三：提交** 导出最终 xlsx，提交评审。',
    ].join('\n');
    expect(shouldSuggestDecomposition(prompt)).toBe(true);
  });

  it('returns true for English Phase/Step structured prompts', () => {
    expect(shouldSuggestDecomposition(
      'Build the data pipeline.\nPhase 1: ingest the sources.\nPhase 2: transform and validate.\nPhase 3: publish the dashboard.',
    )).toBe(true);
    expect(shouldSuggestDecomposition(
      'Step 1: scaffold the project. Step 2: implement the API. Step 3: write tests.',
    )).toBe(true);
  });

  it('a single phase mention alone does not trigger', () => {
    expect(shouldSuggestDecomposition('这个阶段先不用管，帮我把这句话翻译成英文就行')).toBe(false);
  });
});
