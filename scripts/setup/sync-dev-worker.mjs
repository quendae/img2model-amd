import { access, copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), '..', '..');

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function syncDevRuntime({
  platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
  repoRoot = defaultRepoRoot,
} = {}) {
  if (platform !== 'win32') {
    return { synced: false, reason: 'non-windows' };
  }
  if (!localAppData) {
    return { synced: false, reason: 'localappdata-missing' };
  }

  const runtimeDir = join(localAppData, 'Img2ModelAMD', 'runtime', 'native-rocm');
  if (!(await exists(runtimeDir))) {
    return { synced: false, reason: 'runtime-missing', runtimeDir };
  }

  const workerSource = join(repoRoot, 'backends', 'hunyuan', 'worker.py');
  const workerBaseSource = join(repoRoot, 'backends', 'hunyuan', 'worker_base.py');
  const meshProcessingSource = join(repoRoot, 'backends', 'mesh_processing');
  const installedWorker = join(runtimeDir, 'worker.py');
  const installedWorkerBase = join(runtimeDir, 'worker_base.py');
  const installedBackendsRoot = join(runtimeDir, 'backends');
  const installedMeshProcessing = join(installedBackendsRoot, 'mesh_processing');

  for (const source of [workerSource, workerBaseSource, meshProcessingSource]) {
    if (!(await exists(source))) {
      throw new Error(`Development runtime sync source is missing: ${source}`);
    }
  }

  await copyFile(workerSource, installedWorker);
  await copyFile(workerBaseSource, installedWorkerBase);
  await mkdir(installedBackendsRoot, { recursive: true });
  await writeFile(join(installedBackendsRoot, '__init__.py'), '', 'utf8');
  await rm(installedMeshProcessing, { recursive: true, force: true });
  await cp(meshProcessingSource, installedMeshProcessing, { recursive: true, force: true });

  return {
    synced: true,
    runtimeDir,
    worker: installedWorker,
    meshProcessing: installedMeshProcessing,
  };
}

const launchedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath);
if (launchedDirectly) {
  try {
    const result = await syncDevRuntime();
    if (result.synced) {
      console.log(`[Img2Model AMD] Synced development worker: ${result.worker}`);
      console.log(`[Img2Model AMD] Synced mesh backend: ${result.meshProcessing}`);
    } else if (result.reason === 'runtime-missing') {
      console.log(`[Img2Model AMD] Native ROCm runtime not installed yet; dev sync skipped: ${result.runtimeDir}`);
    } else {
      console.log(`[Img2Model AMD] Development runtime sync skipped: ${result.reason}`);
    }
  } catch (error) {
    console.error(`[Img2Model AMD] Development runtime sync failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
