import { useCallback, useState } from 'react';
import type {
  BackendId,
  CleanupAdvancedOverrides,
  CleanupPreset,
  GenerationOptions,
  GenerationPhase,
  GenerationProgress,
  GenerationTimingSummary,
  ShapeOutputMode,
  TextureEngineId,
  TextureProfile,
  TextureRetryContext,
  TextureStylePreset,
} from '../domain/types';
import {
  cleanupMesh,
  generateShape,
  textureMesh,
  type GenerateResult,
  type MeshCleanupRequest,
  type WorkerProgressEvent,
} from './tauri';

export interface ShapeWorkflowRequest {
  backend: BackendId;
  image: string;
  output: string;
  outputMode: ShapeOutputMode;
  shapeProfile: GenerationOptions['profile'];
  steps: number;
  seed: number;
  removeBackground: boolean;
  textureEngine: TextureEngineId;
  textureProfile: TextureProfile;
  textureStylePreset?: TextureStylePreset;
  textureStyleStrength?: number;
  preserveSourceColors?: boolean;
  styleReference?: string | null;
  textureMaxFaces?: number;
  cleanupPreset?: CleanupPreset;
  cleanupOverrides?: CleanupAdvancedOverrides;
}

export interface TextureWorkflowRequest extends TextureRetryContext {}

export interface MeshWorkflowRequest {
  input: string;
  output: string;
  preset: CleanupPreset;
  overrides: CleanupAdvancedOverrides;
}

interface StageTracker {
  lastStage?: string;
  lastAt?: number;
  durations: Record<string, number>;
}

interface CleanupOutcome {
  output: string;
  metadata: Partial<GenerationTimingSummary>;
}

const stageLabels: Record<string, string> = {
  starting_backend: 'Starting AMD backend…',
  preparing_input: 'Preparing source image…',
  loading_model: 'Loading Hunyuan model…',
  running_shape: 'Generating 3D shape…',
  cleaning_mesh: 'Cleaning mesh…',
  repairing_mesh: 'Repairing mesh topology…',
  reducing_mesh: 'Reducing mesh to game-ready budget…',
  validating_mesh: 'Validating cleaned mesh…',
  exporting_clean_mesh: 'Saving cleaned mesh…',
  preparing_mesh: 'Preparing mesh for texturing…',
  mesh_ready: 'Texture mesh is ready…',
  running_texture: 'Generating Hunyuan Paint texture…',
  stylizing_texture: 'Applying texture style…',
  postprocessing: 'Exporting model…',
  completed: 'Generation complete.',
};

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function clampProgress(value: number | null | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function overallProgress(
  phase: GenerationPhase,
  raw: number,
  includesTexture: boolean,
): number {
  const value = clampProgress(raw);
  if (!includesTexture) return value;
  return phase === 'shape' ? value * 0.25 : 0.25 + value * 0.75;
}

function eventLabel(phase: GenerationPhase, event: WorkerProgressEvent): string {
  if (event.stage === 'mesh_ready' && typeof event.faces_after === 'number') {
    return `Texture mesh ready · ${event.faces_after.toLocaleString()} triangles`;
  }
  if (event.stage && stageLabels[event.stage]) return stageLabels[event.stage];
  if (phase === 'shape') return 'Generating 3D shape…';
  if (phase === 'mesh') return 'Cleaning mesh…';
  return 'Generating texture…';
}

function addSuffixBeforeExtension(path: string, suffix: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  if (dot <= separator) return `${path}${suffix}`;
  return `${path.slice(0, dot)}${suffix}${path.slice(dot)}`;
}

export function shapeWorkflowPaths(finalOutput: string, includesTexture: boolean, cleanupEnabled: boolean) {
  if (!cleanupEnabled) {
    return { raw: finalOutput, cleaned: finalOutput, final: finalOutput };
  }
  if (includesTexture) {
    return {
      raw: addSuffixBeforeExtension(finalOutput, '-shape'),
      cleaned: addSuffixBeforeExtension(finalOutput, '-clean'),
      final: finalOutput,
    };
  }
  return {
    raw: addSuffixBeforeExtension(finalOutput, '-shape'),
    cleaned: finalOutput,
    final: finalOutput,
  };
}

function noteStage(tracker: StageTracker, stage: string | null | undefined, at: number): void {
  if (!stage || stage === tracker.lastStage) return;
  if (tracker.lastStage && tracker.lastAt !== undefined) {
    tracker.durations[tracker.lastStage] = (tracker.durations[tracker.lastStage] ?? 0) + (at - tracker.lastAt);
  }
  tracker.lastStage = stage;
  tracker.lastAt = at;
}

function finishStages(tracker: StageTracker, at: number): Record<string, number> {
  if (tracker.lastStage && tracker.lastAt !== undefined) {
    tracker.durations[tracker.lastStage] = (tracker.durations[tracker.lastStage] ?? 0) + (at - tracker.lastAt);
  }
  tracker.lastStage = undefined;
  tracker.lastAt = undefined;
  return { ...tracker.durations };
}

function resultMetadata(result: GenerateResult): Partial<GenerationTimingSummary> {
  const resolved = result.resolved_profile;
  return {
    textureTargetTriangles: result.max_faces ?? undefined,
    trianglesBefore: result.faces_before ?? undefined,
    trianglesAfter: result.faces_after ?? undefined,
    resolvedTextureProfile:
      resolved === 'safe' || resolved === 'balanced' || resolved === 'quality' ? resolved : undefined,
    cacheHit: result.cache_hit ?? undefined,
    cacheKind: result.cache_kind ?? undefined,
    imageCacheHit: result.image_cache_hit ?? undefined,
    meshCacheHit: result.mesh_cache_hit ?? undefined,
    cleanupCacheHit: result.cleanup_cache_hit ?? undefined,
    cleanupReport: result.cleanup_report ?? undefined,
    meshCleanupMs: result.mesh_cleanup_ms ?? undefined,
    modelLoadMs: result.model_load_ms ?? undefined,
    imagePreprocessMs: result.image_preprocess_ms ?? undefined,
    meshPreprocessMs: result.mesh_preprocess_ms ?? undefined,
    inferenceMs: result.inference_ms ?? undefined,
    preprocessMs: result.preprocess_ms ?? undefined,
    exportMs: result.export_ms ?? undefined,
    outputSizeBytes: result.output_size_bytes ?? undefined,
  };
}

function mergeMetadata(
  ...parts: Array<Partial<GenerationTimingSummary> | undefined>
): Partial<GenerationTimingSummary> {
  const merged: Partial<GenerationTimingSummary> = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [key, value] of Object.entries(part)) {
      if (value !== undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}

export function useGenerationJob() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [message, setMessage] = useState('Choose a source image to begin.');
  const [error, setError] = useState<string | null>(null);
  const [technicalError, setTechnicalError] = useState<string | null>(null);
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [preservedShapePath, setPreservedShapePath] = useState<string | null>(null);
  const [cleanedShapePath, setCleanedShapePath] = useState<string | null>(null);
  const [retryContext, setRetryContext] = useState<TextureRetryContext | null>(null);
  const [timingSummary, setTimingSummary] = useState<GenerationTimingSummary | null>(null);
  const [workerNeedsRestart, setWorkerNeedsRestart] = useState(false);

  const clearError = useCallback(() => {
    setError(null);
    setTechnicalError(null);
  }, []);

  const setStatusMessage = useCallback((nextMessage: string) => {
    setMessage(nextMessage);
  }, []);

  const markWorkerRestarted = useCallback(() => {
    setWorkerNeedsRestart(false);
  }, []);

  const resetForNewInput = useCallback((nextMessage = 'Choose a source image to begin.') => {
    setProgress(null);
    setMessage(nextMessage);
    setError(null);
    setTechnicalError(null);
    setResultPath(null);
    setPreservedShapePath(null);
    setCleanedShapePath(null);
    setRetryContext(null);
    setTimingSummary(null);
  }, []);

  const setProgressFromEvent = useCallback((
    phase: GenerationPhase,
    event: WorkerProgressEvent,
    includesTexture: boolean,
    tracker?: StageTracker,
  ) => {
    if (event.event === 'error' || event.event === 'cache') return;
    if (tracker) noteStage(tracker, event.stage, nowMs());
    const next: GenerationProgress = {
      phase,
      value: overallProgress(phase, event.progress ?? 0, includesTexture),
      label: eventLabel(phase, event),
    };
    setProgress(next);
    setMessage(next.label);
  }, []);

  const runCleanupInternal = useCallback(async (
    request: MeshCleanupRequest,
    options: {
      keepBusy: boolean;
      includesTexture: boolean;
      totalStartedAt: number;
      shapeMs?: number;
      priorMetadata?: Partial<GenerationTimingSummary>;
    },
  ): Promise<CleanupOutcome | null> => {
    const startedAt = nowMs();
    setProgress({
      phase: 'mesh',
      value: options.includesTexture ? 0.3 : 0,
      label: 'Cleaning mesh…',
    });
    setMessage('Cleaning mesh…');

    try {
      const result = await cleanupMesh(
        request,
        (event) => setProgressFromEvent('mesh', event, options.includesTexture),
      );
      const finishedAt = nowMs();
      const metadata = mergeMetadata(
        options.priorMetadata,
        resultMetadata(result),
        { meshCleanupMs: result.mesh_cleanup_ms ?? finishedAt - startedAt },
      );

      if (!result.ok) {
        setTechnicalError(result.error ?? null);
        setError('Mesh cleanup failed. The original mesh was preserved.');
        setMessage('Mesh cleanup failed; original mesh was preserved.');
        setTimingSummary({
          shapeMs: options.shapeMs,
          totalMs: finishedAt - options.totalStartedAt,
          ...metadata,
        });
        return null;
      }

      const output = result.output ?? request.output;
      setCleanedShapePath(output);
      setResultPath(output);
      setTimingSummary({
        shapeMs: options.shapeMs,
        totalMs: finishedAt - options.totalStartedAt,
        ...metadata,
      });
      return { output, metadata };
    } catch (reason) {
      const finishedAt = nowMs();
      setTechnicalError(String(reason));
      setError('Mesh cleanup failed. The original mesh was preserved.');
      setMessage('Mesh cleanup failed; original mesh was preserved.');
      setTimingSummary({
        shapeMs: options.shapeMs,
        totalMs: finishedAt - options.totalStartedAt,
        ...options.priorMetadata,
      });
      return null;
    } finally {
      if (!options.keepBusy) setBusy(false);
    }
  }, [setProgressFromEvent]);

  const runTextureInternal = useCallback(async (
    request: TextureWorkflowRequest,
    options?: {
      includesShape?: boolean;
      shapeMs?: number;
      totalStartedAt?: number;
      keepBusy?: boolean;
      preserveExistingShape?: boolean;
      priorMetadata?: Partial<GenerationTimingSummary>;
    },
  ): Promise<string | null> => {
    const includesShape = Boolean(options?.includesShape);
    const stylePreset = request.stylePreset ?? 'match-source';
    const textureStartedAt = nowMs();
    const totalStartedAt = options?.totalStartedAt ?? textureStartedAt;
    const stageTracker: StageTracker = { durations: {} };

    if (!options?.keepBusy) {
      setBusy(true);
      clearError();
      setRetryContext(null);
      setTimingSummary(null);
    }
    if (!options?.preserveExistingShape) {
      setPreservedShapePath(request.mesh);
    }
    setResultPath(request.mesh);
    setProgress({
      phase: 'texture',
      value: includesShape ? 0.25 : 0,
      label: 'Starting Hunyuan Paint texture stage…',
    });
    setMessage('Starting Hunyuan Paint texture stage…');

    try {
      const result = await textureMesh(
        {
          backend: request.backend,
          engine: request.engine,
          profile: request.profile,
          stylePreset,
          styleStrength: request.styleStrength ?? 1.0,
          preserveSourceColors: request.preserveSourceColors ?? true,
          styleReference: request.styleReference ?? null,
          maxFaces: request.maxFaces,
          mesh: request.mesh,
          image: request.image,
          output: request.output,
          model: 'tencent/Hunyuan3D-2',
          subfolder: 'hunyuan3d-paint-v2-0-turbo',
          removeBackground: request.removeBackground,
        },
        (event) => setProgressFromEvent('texture', event, includesShape, stageTracker),
      );

      const finishedAt = nowMs();
      const textureMs = finishedAt - textureStartedAt;
      const textureStages = finishStages(stageTracker, finishedAt);
      const metadata = mergeMetadata(
        options?.priorMetadata,
        { textureTargetTriangles: request.maxFaces },
        resultMetadata(result),
      );

      if (!result.ok) {
        setTechnicalError(result.error ?? null);
        setRetryContext({ ...request, stylePreset });
        if (result.error_kind === 'worker_crashed') {
          setWorkerNeedsRestart(true);
          setError('Persistent Hunyuan worker crashed during texture generation. The generated shape was preserved successfully.');
          setMessage('Texture worker crashed; shape output was preserved.');
        } else if (result.error_kind === 'out_of_memory') {
          setError('Texture generation ran out of GPU memory. The generated shape was preserved successfully.');
          setMessage('Texture stage ran out of GPU memory; shape output was preserved.');
        } else {
          setError('Texture generation failed. The generated shape was preserved successfully.');
          setMessage('Texture stage failed; shape output was preserved.');
        }
        setTimingSummary({
          shapeMs: options?.shapeMs,
          textureMs,
          totalMs: finishedAt - totalStartedAt,
          textureStages,
          ...metadata,
        });
        return null;
      }

      const output = result.output ?? request.output;
      setResultPath(output);
      setProgress({ phase: 'texture', value: 1, label: includesShape ? 'Shape + texture complete.' : 'Texture complete.' });
      setMessage(includesShape ? `Shape + texture completed: ${output}` : `Texture completed: ${output}`);
      setRetryContext(null);
      setTimingSummary({
        shapeMs: options?.shapeMs,
        textureMs,
        totalMs: finishedAt - totalStartedAt,
        textureStages,
        ...metadata,
      });
      return output;
    } catch (reason) {
      const finishedAt = nowMs();
      const textureMs = finishedAt - textureStartedAt;
      setTechnicalError(String(reason));
      setError('Texture generation failed. The generated shape was preserved successfully.');
      setMessage('Texture stage failed; shape output was preserved.');
      setRetryContext({ ...request, stylePreset });
      setTimingSummary({
        shapeMs: options?.shapeMs,
        textureMs,
        totalMs: finishedAt - totalStartedAt,
        textureStages: finishStages(stageTracker, finishedAt),
        ...options?.priorMetadata,
        textureTargetTriangles: request.maxFaces,
      });
      return null;
    } finally {
      if (!options?.keepBusy) setBusy(false);
    }
  }, [clearError, setProgressFromEvent]);

  const runShapeWorkflow = useCallback(async (request: ShapeWorkflowRequest): Promise<string | null> => {
    const includesTexture = request.outputMode === 'model-and-texture';
    const cleanupPreset = request.cleanupPreset ?? 'off';
    const cleanupOverrides = request.cleanupOverrides ?? {};
    const cleanupEnabled = cleanupPreset !== 'off';
    const paths = shapeWorkflowPaths(request.output, includesTexture, cleanupEnabled);
    const totalStartedAt = nowMs();
    const shapeStartedAt = totalStartedAt;

    setBusy(true);
    clearError();
    setRetryContext(null);
    setTimingSummary(null);
    setPreservedShapePath(null);
    setCleanedShapePath(null);
    setProgress({ phase: 'shape', value: 0, label: 'Starting Hunyuan shape generation…' });
    setMessage('Starting Hunyuan shape generation…');

    try {
      const result = await generateShape(
        {
          backend: request.backend,
          input: request.image,
          output: paths.raw,
          model: 'tencent/Hunyuan3D-2mini',
          subfolder: 'hunyuan3d-dit-v2-mini',
          steps: request.steps,
          seed: request.seed,
          removeBackground: request.removeBackground,
        },
        (event) => setProgressFromEvent('shape', event, includesTexture),
      );

      const shapeFinishedAt = nowMs();
      const shapeMs = shapeFinishedAt - shapeStartedAt;
      const shapeMetadata = resultMetadata(result);
      if (!result.ok) {
        setTechnicalError(result.error ?? null);
        if (result.error_kind === 'worker_crashed') {
          setWorkerNeedsRestart(true);
          setError('Persistent Hunyuan worker crashed during shape generation.');
          setMessage('Shape worker crashed. Restart the worker before retrying.');
        } else {
          setError(result.error ?? 'Shape generation failed without an error message.');
          setMessage('Shape generation failed.');
        }
        setTimingSummary({
          shapeMs,
          totalMs: shapeFinishedAt - totalStartedAt,
          ...shapeMetadata,
        });
        return null;
      }

      const rawShapePath = result.output ?? paths.raw;
      setPreservedShapePath(rawShapePath);
      setResultPath(rawShapePath);

      let nextMesh = rawShapePath;
      let cleanupMetadata: Partial<GenerationTimingSummary> | undefined;
      if (cleanupEnabled) {
        const cleanup = await runCleanupInternal(
          {
            input: rawShapePath,
            output: paths.cleaned,
            preset: cleanupPreset,
            overrides: cleanupOverrides,
          },
          {
            keepBusy: true,
            includesTexture,
            totalStartedAt,
            shapeMs,
            priorMetadata: shapeMetadata,
          },
        );
        if (!cleanup) return null;
        nextMesh = cleanup.output;
        cleanupMetadata = cleanup.metadata;
      }

      if (!includesTexture) {
        const finishedAt = nowMs();
        setProgress({ phase: cleanupEnabled ? 'mesh' : 'shape', value: 1, label: cleanupEnabled ? 'Shape + cleanup complete.' : 'Shape complete.' });
        setMessage(cleanupEnabled ? `Shape + cleanup completed: ${nextMesh}` : `Shape completed: ${nextMesh}`);
        setTimingSummary({
          shapeMs,
          totalMs: finishedAt - totalStartedAt,
          ...mergeMetadata(shapeMetadata, cleanupMetadata),
        });
        return nextMesh;
      }

      const textureRequest: TextureWorkflowRequest = {
        backend: request.backend,
        engine: request.textureEngine,
        profile: request.textureProfile,
        stylePreset: request.textureStylePreset ?? 'match-source',
        styleStrength: request.textureStyleStrength ?? 1.0,
        preserveSourceColors: request.preserveSourceColors ?? true,
        styleReference: request.styleReference ?? null,
        maxFaces: request.textureMaxFaces,
        mesh: nextMesh,
        image: request.image,
        output: paths.final,
        removeBackground: request.removeBackground,
      };
      return await runTextureInternal(textureRequest, {
        includesShape: true,
        shapeMs,
        totalStartedAt,
        keepBusy: true,
        preserveExistingShape: true,
        priorMetadata: mergeMetadata(shapeMetadata, cleanupMetadata),
      });
    } catch (reason) {
      setTechnicalError(String(reason));
      setError(String(reason));
      setMessage('Generation failed.');
      setTimingSummary({ totalMs: nowMs() - totalStartedAt });
      return null;
    } finally {
      setBusy(false);
    }
  }, [clearError, runCleanupInternal, runTextureInternal, setProgressFromEvent]);

  const runTextureWorkflow = useCallback(async (request: TextureWorkflowRequest): Promise<string | null> => {
    return runTextureInternal(request);
  }, [runTextureInternal]);

  const runMeshWorkflow = useCallback(async (request: MeshWorkflowRequest): Promise<string | null> => {
    const totalStartedAt = nowMs();
    setBusy(true);
    clearError();
    setRetryContext(null);
    setTimingSummary(null);
    setCleanedShapePath(null);
    setPreservedShapePath(request.input);
    setResultPath(request.input);
    setProgress({ phase: 'mesh', value: 0, label: 'Cleaning mesh…' });
    setMessage('Cleaning mesh…');

    try {
      const cleanup = await runCleanupInternal(
        {
          input: request.input,
          output: request.output,
          preset: request.preset,
          overrides: request.overrides,
        },
        {
          keepBusy: true,
          includesTexture: false,
          totalStartedAt,
        },
      );
      if (!cleanup) return null;
      const finishedAt = nowMs();
      setProgress({ phase: 'mesh', value: 1, label: 'Mesh cleanup complete.' });
      setMessage(`Mesh cleanup completed: ${cleanup.output}`);
      setTimingSummary({
        totalMs: finishedAt - totalStartedAt,
        ...cleanup.metadata,
      });
      return cleanup.output;
    } finally {
      setBusy(false);
    }
  }, [clearError, runCleanupInternal]);

  const retryTexture = useCallback(async (): Promise<string | null> => {
    if (!retryContext) return null;
    return runTextureInternal(retryContext);
  }, [retryContext, runTextureInternal]);

  const retryTextureSafe = useCallback(async (): Promise<string | null> => {
    if (!retryContext) return null;
    return runTextureInternal({ ...retryContext, profile: 'safe' });
  }, [retryContext, runTextureInternal]);

  return {
    busy,
    progress,
    message,
    error,
    technicalError,
    resultPath,
    preservedShapePath,
    cleanedShapePath,
    retryContext,
    timingSummary,
    workerNeedsRestart,
    runShapeWorkflow,
    runTextureWorkflow,
    runMeshWorkflow,
    retryTexture,
    retryTextureSafe,
    clearError,
    setStatusMessage,
    resetForNewInput,
    markWorkerRestarted,
  };
}
