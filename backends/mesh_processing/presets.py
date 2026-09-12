from dataclasses import asdict

from .models import CleanupSettings, ResolvedCleanupConfig

ALGORITHM_VERSION = "mesh-cleanup-v1"

PRESET_SETTINGS = {
    "off": CleanupSettings(False, False, 0.0, False, 0.0, False, 0.0, 0.0, 0.0, False, 0, 0.0, 0.0, False),
    "light": CleanupSettings(True, True, 1e-7, True, 1e-5, False, 0.0, 0.0, 0.0, False, 0, 0.0, 0.0, True),
    "game-ready": CleanupSettings(True, True, 1e-6, True, 5e-4, True, 4.0, 5e-4, 55.0, True, 2, 0.25, -0.26, True),
    "aggressive": CleanupSettings(True, True, 5e-6, True, 2e-3, True, 2.75, 1.5e-3, 40.0, True, 4, 0.35, -0.36, True),
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
    label = _LABELS[preset]
    changed = any(values[key] != getattr(base, key) for key in overrides)
    if changed:
        label = f"Custom (from {label})"
    return ResolvedCleanupConfig(preset, label, ALGORITHM_VERSION, settings)
