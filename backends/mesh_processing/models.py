from dataclasses import asdict, dataclass, field
from typing import Literal

CleanupPreset = Literal["off", "light", "game-ready", "aggressive"]


@dataclass(frozen=True)
class CleanupSettings:
    remove_degenerate: bool
    weld_vertices: bool
    weld_relative_epsilon: float
    remove_small_islands: bool
    min_component_area_ratio: float
    spike_cleanup: bool
    spike_edge_ratio: float
    spike_max_area_ratio: float
    spike_normal_angle_deg: float
    smooth_surface: bool
    smoothing_iterations: int
    taubin_lambda: float
    taubin_nu: float
    recompute_normals: bool


@dataclass(frozen=True)
class ResolvedCleanupConfig:
    preset: CleanupPreset
    label: str
    algorithm_version: str
    settings: CleanupSettings


@dataclass
class CleanupReport:
    preset: str
    config_label: str
    algorithm_version: str
    triangles_before: int
    triangles_after: int
    vertices_before: int
    vertices_after: int
    components_before: int
    components_after: int
    components_removed: int = 0
    vertices_welded: int = 0
    spikes_adjusted: int = 0
    cleanup_ms: float = 0.0
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return asdict(self)
