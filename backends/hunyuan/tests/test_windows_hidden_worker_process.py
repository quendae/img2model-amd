from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_RS = REPO_ROOT / "apps" / "desktop" / "src-tauri" / "src" / "worker.rs"
WORKER_SESSION_RS = REPO_ROOT / "apps" / "desktop" / "src-tauri" / "src" / "worker_session.rs"


class WindowsHiddenWorkerProcessTests(unittest.TestCase):
    def test_all_python_worker_processes_use_no_window_configuration(self):
        worker = WORKER_RS.read_text(encoding="utf-8")
        session = WORKER_SESSION_RS.read_text(encoding="utf-8")

        self.assertIn("WINDOWS_CREATE_NO_WINDOW", worker)
        self.assertIn("creation_flags(WINDOWS_CREATE_NO_WINDOW)", worker)
        self.assertGreaterEqual(
            worker.count("configure_background_process(&mut command)"),
            2,
            "one-shot and streamed worker launches must both hide the Windows console",
        )
        self.assertIn("configure_background_process", session)
        self.assertIn("configure_background_process(&mut command)", session)


if __name__ == "__main__":
    unittest.main()
