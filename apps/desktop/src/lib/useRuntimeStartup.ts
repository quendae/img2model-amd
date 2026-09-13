import { useCallback, useEffect, useRef, useState } from 'react';
import type { TextureHealth, WorkerHealth } from '../domain/types';
import {
  getHunyuanHealth,
  getHunyuanTextureHealth,
  preloadHunyuanShape,
} from './tauri';

export type RuntimePhase = 'starting' | 'checking' | 'preloading' | 'ready' | 'error';

export interface RuntimeStartupState {
  phase: RuntimePhase;
  health: WorkerHealth | null;
  textureHealth: TextureHealth | null;
  shapeCacheReady: boolean;
  shapePreloadMs?: number;
  error: string | null;
  initialize: () => Promise<void>;
  ensureShapePreloaded: () => Promise<void>;
  markShapeEvicted: () => void;
}

export function useRuntimeStartup(): RuntimeStartupState {
  const [phase, setPhase] = useState<RuntimePhase>('starting');
  const [health, setHealth] = useState<WorkerHealth | null>(null);
  const [textureHealth, setTextureHealth] = useState<TextureHealth | null>(null);
  const [shapeCacheReady, setShapeCacheReady] = useState(false);
  const [shapePreloadMs, setShapePreloadMs] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);
  const preloadPromiseRef = useRef<Promise<void> | null>(null);

  const ensureShapePreloaded = useCallback(async () => {
    if (preloadPromiseRef.current) {
      await preloadPromiseRef.current;
      return;
    }

    const preload = (async () => {
      setPhase('preloading');
      setError(null);
      try {
        const result = await preloadHunyuanShape();
        if (!result.ok) {
          throw new Error(result.error ?? 'Hunyuan Shape preload failed.');
        }
        setShapeCacheReady(true);
        setShapePreloadMs(result.model_load_ms ?? undefined);
        setPhase('ready');
      } catch (reason) {
        setShapeCacheReady(false);
        setPhase('error');
        setError(String(reason));
      }
    })();

    preloadPromiseRef.current = preload;
    try {
      await preload;
    } finally {
      preloadPromiseRef.current = null;
    }
  }, []);

  const initialize = useCallback(async () => {
    setPhase('checking');
    setError(null);
    setShapeCacheReady(false);
    setShapePreloadMs(undefined);

    try {
      const healthResult = await getHunyuanHealth();
      setHealth(healthResult);
      if (!healthResult.ok) {
        setTextureHealth(null);
        setPhase('error');
        setError(healthResult.error ?? 'Hunyuan runtime is unavailable.');
        return;
      }

      try {
        setTextureHealth(await getHunyuanTextureHealth());
      } catch {
        setTextureHealth(null);
      }

      await ensureShapePreloaded();
    } catch (reason) {
      setHealth(null);
      setTextureHealth(null);
      setShapeCacheReady(false);
      setPhase('error');
      setError(String(reason));
    }
  }, [ensureShapePreloaded]);

  const markShapeEvicted = useCallback(() => {
    setShapeCacheReady(false);
  }, []);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  return {
    phase,
    health,
    textureHealth,
    shapeCacheReady,
    shapePreloadMs,
    error,
    initialize,
    ensureShapePreloaded,
    markShapeEvicted,
  };
}
