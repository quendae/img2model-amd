import { useCallback, useState } from 'react';
import type {
  BackendId,
  GenerationOptions,
  GenerationPhase,
  GenerationProgress,
  GenerationTimingSummary,
  ShapeOutputMode,
  TextureEngineId,
  TextureProfile,
  TextureRetryContext,
} from '../domain/types';
import { generateShape, textureMesh, type GenerateResult, type WorkerProgressEvent } from './tauri';

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
}

export interface TextureWorkflowRequest extends TextureRetryContext {}

interface StageTracker {
  lastStage?: string;
  lastAt?: number;
  durations: Record<string, number>;
}

const stageLabels: Record<string, string> = {
  starting_backend: 'Starting AMD backend…',
  preparing_input: 'Preparing source image…',
  loading_model: 'Loading Hunyuan model…',
  running_shape: 'Generating 3D shape…',
  preparing_mesh: 'Preparing mesh for texturing…',
  mesh_ready: 'Texture mesh is ready…',
  running_texture: 'Generating Hunyuan Paint texture…',
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
  return phase === 'shape' ? 'Generating 3D shape…' : 'Generating texture…';
}

function addSuffixBeforeExtension(path: string, suffix: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  if (dot <= separator) return `${path}${suffix}`;
  return `${path.slice(0, dot)}${suffix}${path.slice(dot)}`;
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
    trianglesBefore: result.faces_before ?? undefined,
    trianglesAfter: result.faces_after ?? undefined,
    resolvedTextureProfile:
      resolved === 'safe' || resolved === 'balanced' || resolved === 'quality' ? resolved : undefined,
    cacheHit: result.cache_hit ?? undefined,
    cacheKind: result.cache_kind ?? undefined,
    meshCacheHit: result.mesh_cache_hit ?? undefined,
    modelLoadMs: result.model_load_ms ?? undefined,
    inferenceMs: result.inference_ms ?? undefined,
    preprocessMs: result.preprocess_ms ?? undefined,
    exportMs: result.export_ms ?? undefined,
  };
}

export function useGenerationJob() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [message, setMessage] = useState('Choose a source image to begin.');
  const [error, setError] = useState<string | null>(null);
  const [technicalError, setTechnicalError] = useState<string | null>(null);
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [preservedShapePath, setPreservedShapePath] = useState<string | null>(null);
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

  const runTextureInternal = useCallback(async (
    request: TextureWorkflowRequest,
    options?: {
      includesShape?: boolean;
      shapeMs?: number;
      totalStartedAt?: number;
      keepBusy?: boolean;
    },
  ): Promise<string | null> => {
    const includesShape = Boolean(options?.includesShape);
    const textureStartedAt = nowMs();
    const totalStartedAt = options?.totalStartedAt ?? textureStartedAt;
    const stageTracker: StageTracker = { durations: {} };

    if (!options?.keepBusy) {
      setBusy(true);
      clearError();
      setRetryContext(null);
      setTimingSummary(null);
    }
    setPreservedShapePath(request.mesh);
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

      if (!result.ok) {
        setTechnicalError(result.error ?? null);
        setRetryContext(request);
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
          ...resultMetadata(result),
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
        ...resultMetadata(result),
      });
      return output;
    } catch (reason) {
      const finishedAt = nowMs();
      const textureMs = finishedAt - textureStartedAt;
      setTechnicalError(String(reason));
      setError('Texture generation failed. The generated shape was preserved successfully.');
      setMessage('Texture stage failed; shape output was preserved.');
      setRetryContext(request);
      setTimingSummary({
        shapeMs: options?.shapeMs,
        textureMs,
        totalMs: finishedAt - totalStartedAt,
        textureStages: finishStages(stageTracker, finishedAt),
      });
      return null;
    } finally {
      if (!options?.keepBusy) setBusy(false);
    }
  }, [clearError, setProgressFromEvent]);

  const runShapeWorkflow = useCallback(async (request: ShapeWorkflowRequest): Promise<string | null> => {
    const includesTexture = request.outputMode === 'model-and-texture';
    const totalStartedAt = nowMs();
    const shapeStartedAt = totalStartedAt;
    const shapeOutput = includesTexture ? addSuffixBeforeExtension(request.output, '-shape') : request.output;

    setBusy(true);
    clearError();
    setRetryContext(null);
    setTimingSummary(null);
    setPreservedShapePath(null);
    setProgress({ phase: 'shape', value: 0, label: 'Starting Hunyuan shape generation…' });
    setMessage('Starting Hunyuan shape generation…');

    try {
      const result = await generateShape(
        {
          backend: request.backend,
          input: request.image,
          output: shapeOutput,
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
          ...resultMetadata(result),
        });
        return null;
      }

      const shapePath = result.output ?? shapeOutput;
      setPreservedShapePath(shapePath);
      setResultPath(shapePath);

      if (!includesTexture) {
        setProgress({ phase: 'shape', value: 1, label: 'Shape complete.' });
        setMessage(`Shape completed: ${shapePath}`);
        setTimingSummary({
          shapeMs,
          totalMs: shapeFinishedAt - totalStartedAt,
          ...resultMetadata(result),
        });
        return shapePath;
      }

      const textureRequest: TextureWorkflowRequest = {
        backend: request.backend,
        engine: request.textureEngine,
        profile: request.textureProfile,
        mesh: shapePath,
        image: request.image,
        output: request.output,
        removeBackground: request.removeBackground,
      };
      return await runTextureInternal(textureRequest, {
        includesShape: true,
        shapeMs,
        totalStartedAt,
        keepBusy: true,
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
  }, [clearError, runTextureInternal, setProgressFromEvent]);

  const runTextureWorkflow = useCallback(async (request: TextureWorkflowRequest): Promise<string | null> => {
    return runTextureInternal(request);
  }, [runTextureInternal]);

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
    retryContext,
    timingSummary,
    workerNeedsRestart,
    runShapeWorkflow,
    runTextureWorkflow,
    retryTexture,
    retryTextureSafe,
    clearError,
    setStatusMessage,
    resetForNewInput,
    markWorkerRestarted,
  };
}
