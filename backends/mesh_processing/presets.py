from dataclasses import asdict

from .models import CleanupSettings, ResolvedCleanupConfig

ALGORITHM_VERSION = "mesh-cleanup-v8"

PRESET_SETTINGS = {
    "off": CleanupSettings(False, False, 0.0, False, 0.0, False, 0.0, 0.0, 0.0, False, 0, 0.0, 0.0, False),
    "light": CleanupSettings(True, True, 1e-7, True, 1e-4, False, 0.0, 0.0, 0.0, False, 0, 0.0, 0.0, True),
    "game-ready": CleanupSettings(True, True, 1e-6, True, 5e-4, False, 0.0, 0.0, 0.0, False, 0, 0.0, 0.0, True),
    "aggressive": CleanupSettings(True, True, 5e-6, True, 2e-3, False, 0.0, 0.0, 0.0, False, 0, 0.0, 0.0, True),
}

_LABELS = {
    "off": "Off",
    "light": "Light",
    "game-ready": "Game-ready",
    "aggressive": "Aggressive",
}
_ALLOWED_OVERRIDE_KEYS = set(CleanupSettings.__dataclass_fields__)


def resolve_cleanup_config(preset: str, overrides: dict[str, object] | None) -> ResolvedCleanupConfig:
    if preset not in PRESET_SETTINGS:
        raise ValueError(f"Unsupported cleanup preset: {preset}")
    base = PRESET_SETTINGS[preset]
    values = asdict(base)
    overrides = overrides or {}
    unknown = set(overrides) - _ALLOWED_OVERRIDE_KEYS
    if unknown:
        raise ValueError(f"Unsupported cleanup setting(s): {', '.join(sorted(unknown))}")
    values.update(overrides)
    settings = CleanupSettings(**values)
    if not 0 <= settings.smoothing_iterations <= 20:
        raise ValueError("smoothing_iterations must be between 0 and 20")
    if not 0.0 <= settings.weld_relative_epsilon <= 1e-2:
        raise ValueError("weld_relative_epsilon must be between 0 and 0.01")
    if not 0.0 <= settings.min_component_area_ratio <= 0.25:
        raise ValueError("min_component_area_ratio must be between 0 and 0.25")
    if not 0.0 <= settings.spike_max_area_ratio <= 0.25:
        raise ValueError("spike_max_area_ratio must be between 0 and 0.25")
    if settings.triangle_budget_mode not in {"auto", "manual"}:
        raise ValueError("triangle_budget_mode must be 'auto' or 'manual'")
    if settings.target_triangles is not None:
        if isinstance(settings.target_triangles, bool) or not isinstance(settings.target_triangles, int):
            raise ValueError("target_triangles must be an integer")
        if not 500 <= settings.target_triangles <= 500000:
            raise ValueError("target_triangles must be between 500 and 500000")
    if settings.triangle_budget_mode == "manual" and settings.target_triangles is None:
        raise ValueError("target_triangles is required when triangle_budget_mode is manual")

    label = _LABELS[preset]
    changed = any(values[key] != getattr(base, key) for key in overrides)
    if changed:
        label = f"Custom (from {label})"
    return ResolvedCleanupConfig(preset, label, ALGORITHM_VERSION, settings)
