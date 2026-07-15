import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { getOutputDir, getWorkspaceAllowedRoots } from '../tools/workspace-policy.js';
import type { ArtifactEvent } from './types.js';
import { createTurnFileArtifactTracker } from './file-artifacts.js';
import { ArtifactCoordinator } from './coordinator.js';

function previewUrl(route: '/api/fs/file' | '/api/fs/preview', path: string): string {
  return `${route}?${new URLSearchParams({ path }).toString()}`;
}

describe('artifacts/file-artifacts', () => {
  const savedMoziHome = process.env.MOZI_HOME;
  let moziHome: string;

  beforeEach(() => {
    moziHome = mkdtempSync(join(tmpdir(), 'mozi-file-artifacts-home-'));
    process.env.MOZI_HOME = moziHome;
    loadConfig('/nonexistent/mozi.json');
  });

  afterEach(() => {
    rmSync(moziHome, { recursive: true, force: true });
    if (savedMoziHome === undefined) {
      delete process.env.MOZI_HOME;
    } else {
      process.env.MOZI_HOME = savedMoziHome;
    }
    loadConfig('/nonexistent/mozi.json');
  });

  it('adds honest preview fields to file_v1 artifacts', async () => {
    const outputDir = getOutputDir();
    mkdirSync(outputDir, { recursive: true });
    const pptxPath = join(outputDir, 'deck.pptx');
    const pdfPath = join(outputDir, 'report.pdf');
    const pngPath = join(outputDir, 'chart.png');
    const txtPath = join(outputDir, 'notes.txt');
    const xlsxPath = join(outputDir, 'budget.xlsx');
    const unknownPath = join(outputDir, 'design.sketch');
    const artifactEvents: ArtifactEvent[] = [];
    const coordinator = new ArtifactCoordinator('turn-preview-fields', (event) => artifactEvents.push(event));
    const tracker = createTurnFileArtifactTracker({
      artifactCoordinator: coordinator,
    });

    writeFileSync(pptxPath, 'pptx bytes');
    writeFileSync(pdfPath, '%PDF-1.4\npdf bytes');
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(txtPath, 'plain text');
    writeFileSync(xlsxPath, 'xlsx bytes');
    writeFileSync(unknownPath, 'unknown deliverable');
    const future = new Date(Date.now() + 2_000);
    for (const path of [pptxPath, pdfPath, pngPath, txtPath, xlsxPath, unknownPath]) {
      utimesSync(path, future, future);
    }

    await tracker.scanAndEmit();

    const dataByFilename = new Map(
      artifactEvents
        .filter((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open')
        .map((event) => [String(event.artifact.data.filename), event.artifact.data]),
    );
    const quickLookAvailable = process.platform === 'darwin';

    expect(dataByFilename.get('deck.pptx')).toMatchObject({
      path: realpathSync(pptxPath),
      ext: 'pptx',
      kind: 'deck',
      previewable: quickLookAvailable,
      ...(quickLookAvailable ? { previewUrl: previewUrl('/api/fs/preview', realpathSync(pptxPath)) } : {}),
      downloadUrl: previewUrl('/api/fs/file', realpathSync(pptxPath)),
    });
    if (!quickLookAvailable) {
      expect(dataByFilename.get('deck.pptx')?.previewUrl).toBeUndefined();
    }

    expect(dataByFilename.get('report.pdf')).toMatchObject({
      path: realpathSync(pdfPath),
      ext: 'pdf',
      kind: 'document',
      previewable: quickLookAvailable,
      ...(quickLookAvailable ? { previewUrl: previewUrl('/api/fs/preview', realpathSync(pdfPath)) } : {}),
    });
    if (!quickLookAvailable) {
      expect(dataByFilename.get('report.pdf')?.previewUrl).toBeUndefined();
    }

    expect(dataByFilename.get('chart.png')).toMatchObject({
      path: realpathSync(pngPath),
      ext: 'png',
      kind: 'image',
      previewable: true,
      previewUrl: previewUrl('/api/fs/file', realpathSync(pngPath)),
    });

    expect(dataByFilename.get('notes.txt')).toMatchObject({
      path: realpathSync(txtPath),
      ext: 'txt',
      kind: 'document',
      previewable: false,
    });
    expect(dataByFilename.get('notes.txt')?.previewUrl).toBeUndefined();
    expect(dataByFilename.get('budget.xlsx')).toMatchObject({
      path: realpathSync(xlsxPath),
      ext: 'xlsx',
      kind: 'sheet',
      downloadUrl: previewUrl('/api/fs/file', realpathSync(xlsxPath)),
    });
    expect(dataByFilename.get('design.sketch')).toBeUndefined();
  });

  it('emits an explicitly reported worker artifact even when it predates the turn scan', async () => {
    const workspaceRoot = getOutputDir();
    expect(getWorkspaceAllowedRoots()).toContain(workspaceRoot);
    mkdirSync(workspaceRoot, { recursive: true });
    const reportPath = join(workspaceRoot, 'worker-report.docx');
    writeFileSync(reportPath, 'docx bytes');
    const events: ArtifactEvent[] = [];
    const tracker = createTurnFileArtifactTracker({
      activeRootPath: workspaceRoot,
      artifactCoordinator: new ArtifactCoordinator('turn-worker-file', event => events.push(event)),
    });

    await tracker.emitPaths([reportPath, reportPath]);

    const opens = events.filter((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open');
    expect(opens).toHaveLength(1);
    expect(opens[0].artifact.data).toMatchObject({
      path: realpathSync(reportPath),
      filename: 'worker-report.docx',
      downloadUrl: previewUrl('/api/fs/file', realpathSync(reportPath)),
    });
  });

  it.each([
    ['xlsx', 'Q2___________-2.xlsx', '2026Q2_12国税务动态.xlsx'],
    ['pdf', '____________.pdf', '2026年Q2税务动态.pdf'],
  ])('converges byte-identical %s deliverables to the newest human-readable filename', async (
    extension,
    placeholderName,
    finalName,
  ) => {
    const outputDir = getOutputDir();
    mkdirSync(outputDir, { recursive: true });
    const placeholderPath = join(outputDir, placeholderName);
    const finalPath = join(outputDir, finalName);
    const bytes = `identical ${extension} bytes`;
    const events: ArtifactEvent[] = [];
    const coordinator = new ArtifactCoordinator(`turn-content-dedupe-${extension}`, event => events.push(event));
    const tracker = createTurnFileArtifactTracker({ artifactCoordinator: coordinator });

    writeFileSync(placeholderPath, bytes);
    utimesSync(placeholderPath, new Date(Date.now() + 1_000), new Date(Date.now() + 1_000));
    await tracker.scanAndEmit();

    writeFileSync(finalPath, bytes);
    utimesSync(finalPath, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
    await tracker.scanAndEmit();

    const opens = events.filter((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open');
    const patches = events.filter((event): event is Extract<ArtifactEvent, { type: 'patch' }> => event.type === 'patch');
    expect(opens).toHaveLength(1);
    expect(patches.at(-1)).toMatchObject({
      artifactId: opens[0].artifact.id,
      patch: {
        title: finalName,
        data: {
          path: realpathSync(finalPath),
          filename: finalName,
        },
      },
    });
    expect(coordinator.resolveByPath(realpathSync(placeholderPath))).toBe(opens[0].artifact.id);
    expect(coordinator.resolveByPath(realpathSync(finalPath))).toBe(opens[0].artifact.id);
  });

  it('keeps same-size deliverables separate when their bytes differ', async () => {
    const outputDir = getOutputDir();
    mkdirSync(outputDir, { recursive: true });
    const firstPath = join(outputDir, '华东报告.pdf');
    const secondPath = join(outputDir, '华南报告.pdf');
    const events: ArtifactEvent[] = [];
    const tracker = createTurnFileArtifactTracker({
      artifactCoordinator: new ArtifactCoordinator('turn-no-false-dedupe', event => events.push(event)),
    });

    writeFileSync(firstPath, 'region-east');
    writeFileSync(secondPath, 'region-south');
    const future = new Date(Date.now() + 2_000);
    utimesSync(firstPath, future, future);
    utimesSync(secondPath, future, future);

    await tracker.scanAndEmit();

    const titles = events
      .filter((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open')
      .map(event => event.artifact.title);
    expect(titles).toEqual(['华东报告.pdf', '华南报告.pdf']);
  });

  it('skips file_v1 when the same realpath was surfaced as a rich artifact this turn', async () => {
    const outputDir = getOutputDir();
    mkdirSync(outputDir, { recursive: true });
    const htmlPath = join(outputDir, 'deck.html');
    const pptxPath = join(outputDir, 'deck.pptx');
    const artifactEvents: ArtifactEvent[] = [];
    const richArtifactPaths = new Set<string>();
    const coordinator = new ArtifactCoordinator('turn-rich-skip', (event) => artifactEvents.push(event));
    const tracker = createTurnFileArtifactTracker({
      richArtifactPaths,
      artifactCoordinator: coordinator,
    });

    writeFileSync(htmlPath, '<!doctype html><html><body>Deck</body></html>');
    writeFileSync(pptxPath, 'pptx bytes');
    const future = new Date(Date.now() + 2_000);
    for (const path of [htmlPath, pptxPath]) {
      utimesSync(path, future, future);
    }
    richArtifactPaths.add(realpathSync(htmlPath));

    await tracker.scanAndEmit();

    const fileArtifactTitles = artifactEvents
      .filter((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open')
      .map((event) => event.artifact.title);

    expect(fileArtifactTitles).toEqual(['deck.pptx']);
  });

  it('does not auto-publish build metadata, cache files, or generator source', async () => {
    const outputDir = getOutputDir();
    const targetDir = join(outputDir, 'target', 'debug', '.fingerprint', 'crate');
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    const reportPath = join(outputDir, 'report.docx');
    writeFileSync(reportPath, 'docx bytes');
    writeFileSync(join(outputDir, 'generate_report.js'), 'console.log("intermediate")');
    writeFileSync(join(targetDir, 'build_script_build-deadbeef.d'), 'metadata');
    writeFileSync(join(targetDir, 'invoked.timestamp'), 'timestamp');
    const future = new Date(Date.now() + 2_000);
    utimesSync(reportPath, future, future);
    utimesSync(join(outputDir, 'generate_report.js'), future, future);
    const events: ArtifactEvent[] = [];
    const tracker = createTurnFileArtifactTracker({
      artifactCoordinator: new ArtifactCoordinator('turn-filter-build-files', event => events.push(event)),
    });

    await tracker.scanAndEmit();

    const titles = events
      .filter((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open')
      .map(event => event.artifact.title);
    expect(titles).toEqual(['report.docx']);
  });

  it('still publishes an explicitly reported uncommon file', async () => {
    const outputDir = getOutputDir();
    mkdirSync(outputDir, { recursive: true });
    const explicitPath = join(outputDir, 'result.custom');
    writeFileSync(explicitPath, 'custom result');
    const events: ArtifactEvent[] = [];
    const tracker = createTurnFileArtifactTracker({
      artifactCoordinator: new ArtifactCoordinator('turn-explicit-custom-file', event => events.push(event)),
    });

    await tracker.emitPaths([explicitPath]);

    const open = events.find((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open');
    expect(open?.artifact.title).toBe('result.custom');
  });

  it('converges a write_file-owned pptx with the output scan by registered path', async () => {
    const outputDir = getOutputDir();
    mkdirSync(outputDir, { recursive: true });
    const pptxPath = join(outputDir, 'owned-deck.pptx');
    const artifactEvents: ArtifactEvent[] = [];
    const coordinator = new ArtifactCoordinator('turn-file-convergence', (event) => artifactEvents.push(event));
    const tracker = createTurnFileArtifactTracker({
      artifactCoordinator: coordinator,
    });

    writeFileSync(pptxPath, 'pptx bytes');
    const future = new Date(Date.now() + 2_000);
    utimesSync(pptxPath, future, future);

    const artifactId = coordinator.openOrGet('write-pptx', {
      plugin_id: 'file_v1',
      title: 'owned-deck.pptx',
      content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      status: 'running',
      fallback_text: 'File ready: owned-deck.pptx',
      data: {
        path: realpathSync(pptxPath),
        filename: 'owned-deck.pptx',
        ext: 'pptx',
        size: Buffer.byteLength('pptx bytes'),
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        kind: 'deck',
        previewable: false,
      },
    });
    coordinator.registerFileWrite('write-pptx', realpathSync(pptxPath));
    coordinator.complete('write-pptx', {
      plugin_id: 'file_v1',
      title: 'owned-deck.pptx',
      data: {
        path: realpathSync(pptxPath),
        filename: 'owned-deck.pptx',
        ext: 'pptx',
        size: Buffer.byteLength('pptx bytes'),
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        kind: 'deck',
        previewable: false,
      },
    });

    await tracker.scanAndEmit();

    const opens = artifactEvents.filter((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open');
    const scanPatch = artifactEvents.find((event): event is Extract<ArtifactEvent, { type: 'patch' }> => (
      event.type === 'patch' &&
      event.artifactId === artifactId &&
      event.patch.plugin_id === 'file_v1' &&
      event.patch.data?.path === realpathSync(pptxPath)
    ));

    expect(opens).toHaveLength(1);
    expect(opens[0].artifact.id).toBe(artifactId);
    expect(scanPatch?.artifactId).toBe(artifactId);
  });

  it('suppresses per-slide render frames and leads with the primary deliverable', async () => {
    const outputDir = getOutputDir();
    mkdirSync(outputDir, { recursive: true });
    const pptxPath = join(outputDir, 'GPT-5.6_deck.pptx');
    const pdfPath = join(outputDir, 'GPT-5.6_deck.pdf');
    const slidePaths = ['slide-01.jpg', 'slide-02.jpg', 'slide-03.jpg'].map((n) => join(outputDir, n));
    const events: ArtifactEvent[] = [];
    const coordinator = new ArtifactCoordinator('turn-curate', (event) => events.push(event));
    const tracker = createTurnFileArtifactTracker({ artifactCoordinator: coordinator });

    writeFileSync(pptxPath, 'pptx bytes');
    writeFileSync(pdfPath, '%PDF-1.4\npdf bytes');
    for (const p of slidePaths) writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff]));
    const future = new Date(Date.now() + 2_000);
    for (const p of [pptxPath, pdfPath, ...slidePaths]) utimesSync(p, future, future);

    await tracker.scanAndEmit();

    const opened = events
      .filter((e): e is Extract<ArtifactEvent, { type: 'open' }> => e.type === 'open')
      .map((e) => String(e.artifact.data.filename));

    // The 11-JPEG render batch is noise next to the deck — none should surface.
    expect(opened).not.toContain('slide-01.jpg');
    expect(opened).not.toContain('slide-02.jpg');
    expect(opened).not.toContain('slide-03.jpg');
    // Deck leads, then the derived PDF.
    expect(opened).toEqual(['GPT-5.6_deck.pptx', 'GPT-5.6_deck.pdf']);
  });

  it('keeps standalone images when there is no primary document deliverable', async () => {
    const outputDir = getOutputDir();
    mkdirSync(outputDir, { recursive: true });
    const imgPath = join(outputDir, 'slide-01.jpg'); // render-frame name, but no deck present
    const events: ArtifactEvent[] = [];
    const coordinator = new ArtifactCoordinator('turn-standalone-img', (event) => events.push(event));
    const tracker = createTurnFileArtifactTracker({ artifactCoordinator: coordinator });

    writeFileSync(imgPath, Buffer.from([0xff, 0xd8, 0xff]));
    const future = new Date(Date.now() + 2_000);
    utimesSync(imgPath, future, future);

    await tracker.scanAndEmit();

    const opened = events
      .filter((e): e is Extract<ArtifactEvent, { type: 'open' }> => e.type === 'open')
      .map((e) => String(e.artifact.data.filename));
    expect(opened).toContain('slide-01.jpg');
  });
});
