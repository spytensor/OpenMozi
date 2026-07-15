import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractClaimedDeliverablePaths, findMissingClaimedDeliverables } from './deliverable-verification.js';
import { getOutputDir } from '../tools/workspace-policy.js';

describe('deliverable-verification', () => {
  let prevHome: string | undefined;
  let home: string;

  beforeEach(() => {
    prevHome = process.env.MOZI_HOME;
    home = mkdtempSync(join(tmpdir(), 'mozi-deliv-'));
    process.env.MOZI_HOME = home;
    mkdirSync(join(home, 'output'), { recursive: true });
    mkdirSync(join(home, 'workspace'), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MOZI_HOME;
    else process.env.MOZI_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  describe('extractClaimedDeliverablePaths', () => {
    it('extracts backtick-quoted and bare deliverable paths', () => {
      const text = 'PPT 已生成。文件：`output/GPT-5.6_模型介绍.pptx`（209KB）。另见 output/data.xlsx 附表。';
      const paths = extractClaimedDeliverablePaths(text);
      expect(paths).toContain('output/GPT-5.6_模型介绍.pptx');
      expect(paths).toContain('output/data.xlsx');
    });

    it('ignores non-deliverable text and bare generic filenames', () => {
      const text = 'I edited `src/index.ts` and mentioned report.pptx as an option.';
      // src/index.ts is not a hard deliverable; bare "report.pptx" has no path separator.
      expect(extractClaimedDeliverablePaths(text)).toEqual([]);
    });
  });

  describe('findMissingClaimedDeliverables', () => {
    it('flags a claimed deliverable that does not exist on disk (the fabrication case)', () => {
      const text = 'PPT 已生成并完成内容校验。文件：`output/GPT-5.6_模型介绍.pptx`（209KB，9 页）。';
      expect(findMissingClaimedDeliverables(text)).toEqual(['output/GPT-5.6_模型介绍.pptx']);
    });

    it('does not flag a claimed deliverable that actually exists (non-empty) in output', () => {
      writeFileSync(join(getOutputDir(), 'GPT-5.6_模型介绍.pptx'), 'PK\x03\x04 fake but non-empty');
      const text = '文件：`output/GPT-5.6_模型介绍.pptx`。';
      expect(findMissingClaimedDeliverables(text)).toEqual([]);
    });

    it('resolves by basename so a slightly-off path prefix still counts as present', () => {
      writeFileSync(join(getOutputDir(), 'deck.pptx'), 'non-empty');
      const text = '交付：`some/other/dir/deck.pptx`';
      expect(findMissingClaimedDeliverables(text)).toEqual([]);
    });

    it('treats an empty file as missing (no real deliverable)', () => {
      writeFileSync(join(getOutputDir(), 'empty.pptx'), '');
      const text = '文件：`output/empty.pptx`';
      expect(findMissingClaimedDeliverables(text)).toEqual(['output/empty.pptx']);
    });

    it('returns empty when the message claims no deliverable', () => {
      expect(findMissingClaimedDeliverables('调研完成，结论见上。')).toEqual([]);
    });
  });
});
