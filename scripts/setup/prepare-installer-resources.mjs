import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const destination = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'resources', 'installer-payload');

const files = [
  'scripts/setup/windows-native-rocm.ps1',
  'scripts/setup/windows-hunyuan-texture.ps1',
  'scripts/setup/install-img2model-runtime.ps1',
  'backends/hunyuan/requirements-base.txt',
  'backends/hunyuan/requirements-repaint.txt',
  'backends/hunyuan/worker.py',
  'backends/hunyuan/worker_base.py',
  'backends/hunyuan/texture_stylizer.py',
  'backends/hunyuan/local_repaint.py',
];

const directories = [
  'backends/mesh_processing',
];

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

for (const relativePath of files) {
  const source = join(repoRoot, ...relativePath.split('/'));
  const target = join(destination, ...relativePath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
}

for (const relativePath of directories) {
  const source = join(repoRoot, ...relativePath.split('/'));
  const target = join(destination, ...relativePath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    filter: (sourcePath) => !sourcePath.includes('__pycache__') && !sourcePath.includes(`${join('mesh_processing', 'tests')}`),
  });
}

console.log(`Prepared Img2Model AMD installer payload: ${destination}`);
