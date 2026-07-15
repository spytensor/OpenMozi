import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MoziConfigSchema } from '../config/index.js';
import { buildRuntimeCapabilityManifest } from './capability-manifest.js';

type PackageJson = {
  version?: string;
};

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf-8')) as PackageJson;
}

describe('core/release-gate', () => {
  it('pins release package versions to 2.0.0', () => {
    expect(readPackageJson('../../package.json').version).toBe('2.0.0');
    expect(readPackageJson('../../ui/package.json').version).toBe('2.0.0');
    expect(readPackageJson('../../desktop/package.json').version).toBe('2.0.0');
  });

  it('loads config defaults and builds the capability manifest', () => {
    const config = MoziConfigSchema.parse({});
    const manifest = buildRuntimeCapabilityManifest(config, ['shell_exec'], 'default');

    expect(config.server.port).toBe(9210);
    expect(config.security.registration).toBe('invite');
    expect(manifest.metadata.max_parallel_agents).toBe(config.system.max_parallel_agents);
    expect(manifest.metadata.registered_tools).toEqual(['shell_exec']);
    expect(manifest.built_in.some((capability) => capability.id === 'direct_brain_execution')).toBe(true);
  });
});
