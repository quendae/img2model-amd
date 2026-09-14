import { invoke } from '@tauri-apps/api/core';

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export const DIAGNOSTIC_LOG_PATH_HINT = '%LOCALAPPDATA%\\Img2ModelAMD\\logs\\img2model-amd.log';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function serializeDetails(details: unknown): string | null {
  if (details === undefined || details === null) return null;
  if (typeof details === 'string') return details;
  if (details instanceof Error) {
    return JSON.stringify({
      name: details.name,
      message: details.message,
      stack: details.stack ?? null,
    });
  }
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function reasonMessage(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason);
}

export async function writeDiagnosticLog(
  level: DiagnosticLevel,
  source: string,
  message: string,
  details?: unknown,
): Promise<void> {
  const serializedDetails = serializeDetails(details);

  if (!isTauri()) {
    if (level === 'error') console.error(`[${source}] ${message}`, serializedDetails ?? '');
    else if (level === 'warn') console.warn(`[${source}] ${message}`, serializedDetails ?? '');
    else console.info(`[${source}] ${message}`, serializedDetails ?? '');
    return;
  }

  try {
    await invoke('append_diagnostic_log', {
      level,
      source,
      message,
      details: serializedDetails,
    });
  } catch (error) {
    console.warn('Could not write Img2Model AMD diagnostic log.', error);
  }
}

let globalDiagnosticsInstalled = false;

export function installGlobalDiagnostics(): void {
  if (typeof window === 'undefined' || globalDiagnosticsInstalled) return;
  globalDiagnosticsInstalled = true;

  window.addEventListener('error', (event) => {
    void writeDiagnosticLog('error', 'window', event.message || 'Uncaught window error', {
      filename: event.filename || null,
      line: event.lineno || null,
      column: event.colno || null,
      error: event.error instanceof Error
        ? { name: event.error.name, message: event.error.message, stack: event.error.stack ?? null }
        : event.error ?? null,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    void writeDiagnosticLog('error', 'promise', `Unhandled rejection: ${reasonMessage(event.reason)}`, event.reason);
  });

  void writeDiagnosticLog('info', 'frontend', 'Frontend bootstrap started.', {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
  });
}
