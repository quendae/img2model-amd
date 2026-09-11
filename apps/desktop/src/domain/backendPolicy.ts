import type { BackendDecision, BackendId, BackendStatus } from './types';

const AUTO_ORDER: BackendId[] = ['native-rocm', 'wsl-rocm', 'vulkan'];

export function chooseBackend(
  statuses: BackendStatus[],
  preferred?: BackendId,
): BackendDecision {
  const byId = new Map(statuses.map((item) => [item.id, item]));

  if (preferred) {
    const selected = byId.get(preferred);
    if (!selected?.healthy) {
      return {
        reason: `Explicit backend ${preferred} is not healthy.`,
        error: `Backend ${preferred} is unavailable or unhealthy; no fallback was applied.`,
      };
    }

    return {
      backend: preferred,
      reason: `Using explicitly selected backend ${preferred}.`,
    };
  }

  for (const backend of AUTO_ORDER) {
    if (byId.get(backend)?.healthy) {
      return {
        backend,
        reason: `Automatically selected ${backend}.`,
      };
    }
  }

  return {
    reason: 'No healthy backend is available.',
    error: 'Install or repair a native ROCm, WSL ROCm, or Vulkan backend.',
  };
}
