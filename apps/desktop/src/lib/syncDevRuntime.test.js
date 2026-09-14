import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncDevRuntime } from '../../../../scripts/setup/sync-dev-worker.mjs';

const tempRoots = [];

async function makeTempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'img2model-dev-sync-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('development runtime synchronization', () => {
  it('replaces the persisted worker and mesh backend with the checked-out source', async () => {
    const root = await makeTempRoot();
    const repoRoot = join(root, 'repo');
    const localAppData = join(root, 'local');
    const runtimeDir = join(localAppData, 'Img2ModelAMD', 'runtime', 'native-rocm');
    const sourceHunyuan = join(repoRoot, 'backends', 'hunyuan');
    const sourceMesh = join(repoRoot, 'backends', 'mesh_processing');

    await mkdir(sourceHunyuan, { recursive: true });
    await mkdir(sourceMesh, { recursive: true });
    await mkdir(join(runtimeDir, 'backends', 'mesh_processing'), { recursive: true });

    await writeFile(join(sourceHunyuan, 'worker.py'), '# source worker\n', 'utf8');
    await writeFile(join(sourceHunyuan, 'worker_base.py'), '# source worker base\n', 'utf8');
    await writeFile(join(sourceMesh, 'presets.py'), 'ALGORITHM_VERSION = "mesh-cleanup-v3"\n', 'utf8');
    await writeFile(join(runtimeDir, 'worker.py'), '# stale worker\n', 'utf8');
    await writeFile(join(runtimeDir, 'backends', 'mesh_processing', 'presets.py'), 'ALGORITHM_VERSION = "mesh-cleanup-v2"\n', 'utf8');

    const result = await syncDevRuntime({ platform: 'win32', localAppData, repoRoot });

    expect(result.synced).toBe(true);
    expect(await readFile(join(runtimeDir, 'worker.py'), 'utf8')).toBe('# source worker\n');
    expect(await readFile(join(runtimeDir, 'worker_base.py'), 'utf8')).toBe('# source worker base\n');
    expect(await readFile(join(runtimeDir, 'backends', 'mesh_processing', 'presets.py'), 'utf8'))
      .toContain('mesh-cleanup-v3');
  });

  it('does not create a fake runtime when native ROCm has not been installed', async () => {
    const root = await makeTempRoot();
    const result = await syncDevRuntime({
      platform: 'win32',
      localAppData: join(root, 'local'),
      repoRoot: join(root, 'repo'),
    });

    expect(result.synced).toBe(false);
    expect(result.reason).toBe('runtime-missing');
  });
});
