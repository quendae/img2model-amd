from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
TAURI_CONFIG = ROOT / "apps" / "desktop" / "src-tauri" / "tauri.conf.json"
DESKTOP_PACKAGE = ROOT / "apps" / "desktop" / "package.json"
CARGO_TOML = ROOT / "apps" / "desktop" / "src-tauri" / "Cargo.toml"
WINDOWS_ICON = ROOT / "apps" / "desktop" / "src-tauri" / "icons" / "icon.ico"
EXPECTED_VERSION = "0.1.1"
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

    def test_windows_icon_is_real_multisize_ico_and_wired_everywhere(self) -> None:
        data = WINDOWS_ICON.read_bytes()
        self.assertGreater(len(data), 10_000, "Windows icon must not be the tiny placeholder ICO")
        self.assertEqual(data[:4], b"\x00\x00\x01\x00", "Expected a Windows ICO file")
        image_count = int.from_bytes(data[4:6], "little")
        self.assertGreaterEqual(image_count, 6, "ICO should contain multiple sizes for Windows shell scaling")

        config = json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))
        bundle = config["bundle"]
        self.assertIn(EXPECTED_ICON, bundle["icon"])
        nsis = bundle["windows"]["nsis"]
        self.assertEqual(nsis["installerIcon"], EXPECTED_ICON)
        self.assertEqual(nsis["uninstallerIcon"], EXPECTED_ICON)


if __name__ == "__main__":
    unittest.main()
