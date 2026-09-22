from __future__ import annotations

import base64
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
TAURI_CONFIG = ROOT / "apps" / "desktop" / "src-tauri" / "tauri.conf.json"
DESKTOP_PACKAGE = ROOT / "apps" / "desktop" / "package.json"
CARGO_TOML = ROOT / "apps" / "desktop" / "src-tauri" / "Cargo.toml"
ICON_SOURCE_B64 = ROOT / "apps" / "desktop" / "src-tauri" / "icons" / "icon-source.png.b64"
PREPARE_BRANDING = ROOT / "scripts" / "setup" / "prepare-branding.mjs"
INNO_SETUP = ROOT / "apps" / "desktop" / "src-tauri" / "windows" / "img2model-amd.iss"
EXPECTED_VERSION = "0.1.2"
EXPECTED_ICON = "icons/icon.ico"


class ReleaseBrandingTests(unittest.TestCase):
    def test_release_version_is_synchronized(self) -> None:
        tauri = json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))
        package = json.loads(DESKTOP_PACKAGE.read_text(encoding="utf-8"))
        cargo = CARGO_TOML.read_text(encoding="utf-8")
        cargo_version = re.search(r'^version\s*=\s*"([^"]+)"', cargo, re.MULTILINE)

        self.assertEqual(tauri["version"], EXPECTED_VERSION)
        self.assertEqual(package["version"], EXPECTED_VERSION)
        self.assertIsNotNone(cargo_version)
        self.assertEqual(cargo_version.group(1), EXPECTED_VERSION)

    def test_windows_icon_source_and_build_pipeline_are_wired_everywhere(self) -> None:
        source = base64.b64decode(ICON_SOURCE_B64.read_text(encoding="utf-8").strip(), validate=True)
        self.assertGreater(len(source), 8_000, "Committed icon source must contain the approved artwork")
        self.assertEqual(source[:8], b"\x89PNG\r\n\x1a\n", "Expected a PNG icon source")

        package = json.loads(DESKTOP_PACKAGE.read_text(encoding="utf-8"))
        self.assertIn("prepare-branding", package["scripts"])
        self.assertIn("prepare-branding", package["scripts"]["prepare-installer"])

        branding = PREPARE_BRANDING.read_text(encoding="utf-8")
        self.assertIn("icon-source.png.b64", branding)
        self.assertIn("tauri", branding)
        self.assertIn("icon", branding)
        self.assertIn("imageCount", branding)
        self.assertIn("10_000", branding)

        config = json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))
        bundle = config["bundle"]
        self.assertIn(EXPECTED_ICON, bundle["icon"])

        inno = INNO_SETUP.read_text(encoding="utf-8")
        self.assertIn("SetupIconFile=..\\icons\\icon.ico", inno)
        self.assertIn("UninstallDisplayIcon={app}\\img2model-amd.exe", inno)


if __name__ == "__main__":
    unittest.main()
