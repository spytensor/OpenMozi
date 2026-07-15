import { describe, expect, it } from 'vitest';
import { evaluatePromptContract, isRuntimeFeatureFile } from './prompt-contract.mjs';

describe('scripts/prompt-contract', () => {
  it('detects runtime feature files', () => {
    expect(isRuntimeFeatureFile('src/gateway/handler.ts')).toBe(true);
    expect(isRuntimeFeatureFile('src/core/model-router.ts')).toBe(true);
    expect(isRuntimeFeatureFile('src/templates/SOUL.md')).toBe(false);
    expect(isRuntimeFeatureFile('src/gateway/handler.test.ts')).toBe(false);
    expect(isRuntimeFeatureFile('README.md')).toBe(false);
  });

  it('fails when runtime files change without prompt/changelog updates', () => {
    const result = evaluatePromptContract([
      'src/gateway/handler.ts',
      'src/core/model-router.ts',
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('passes when runtime files include prompt and changelog updates', () => {
    const result = evaluatePromptContract([
      'src/gateway/handler.ts',
      'src/templates/SOUL.md',
      'CHANGELOG.md',
    ]);
    expect(result.ok).toBe(true);
  });

  it('passes when only non-runtime files change', () => {
    const result = evaluatePromptContract([
      'README.md',
      'docs/ARCHITECTURE-GAPS.md',
    ]);
    expect(result.ok).toBe(true);
  });
});
