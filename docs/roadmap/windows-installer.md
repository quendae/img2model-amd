# Img2Model AMD Windows installer

## Goal

Ship a normal Windows setup executable for Img2Model AMD that installs the Tauri desktop application and can bootstrap the validated native AMD runtime without requiring the source repository.

## Scope

- Primary package: Tauri v2 NSIS `setup.exe` for Windows 11.
- Default install mode: current user; no administrator requirement for the app itself.
- The application installation and the ML runtime are separate:
  - app binaries live in the normal Tauri install directory;
  - runtime remains under `%LOCALAPPDATA%\Img2ModelAMD\runtime\native-rocm`;
  - logs remain under `%LOCALAPPDATA%\Img2ModelAMD\logs`;
  - model/Hugging Face caches are not packaged in the installer and must survive app upgrades/uninstall.
- The installer payload contains the exact worker/backend/setup sources from the same Git revision; runtime bootstrap must never depend on a Git checkout.
- Existing runtime setup remains reusable from the repository for development.
- Installer bootstrap is idempotent: an existing healthy runtime is verified/reused instead of blindly reinstalled.
- Runtime installation must emit a persistent log and return a non-zero exit code on failure.
- Unsupported/missing prerequisites must produce actionable errors rather than silent fallback.

## Runtime bootstrap policy

The first installer slice reuses the currently hardware-validated setup path:

1. ensure Python 3.11 x64 with `py.exe` is available;
2. run the native ROCm/TheRock setup against the bundled payload;
3. run the Hunyuan Paint extension setup against the same runtime;
4. run worker `health --json` and `texture-health --json` checks;
5. persist `IMG2MODEL_PYTHON` and `IMG2MODEL_WORKER` for the current user.

If Python or the Windows C++ toolchain is absent, setup must stop with an explicit prerequisite message. Automatic prerequisite acquisition can be added after this installer path is hardware-validated; the first release must not silently invoke an unpinned package-manager install.

## Upgrade/uninstall

- App upgrades replace application resources but keep `%LOCALAPPDATA%\Img2ModelAMD\runtime` and model caches.
- Uninstall removes the application only. Runtime/model data remains intentionally so a reinstall does not download/rebuild everything again.
- A future explicit `Remove runtime/cache` action may delete that data, but uninstall must not do so implicitly.

## Build/release

- CI must validate PowerShell syntax and prepare the installer resource payload.
- A Windows packaging workflow must build an NSIS installer and upload it as an artifact.
- Models are never embedded in the setup executable.

## Acceptance

On a clean Windows 11 target with supported prerequisites and an RX 6950 XT/gfx1030:

1. launch the setup executable;
2. finish app + runtime installation without a repository checkout;
3. launch Img2Model AMD from the installed shortcut;
4. diagnostics report the installed persistent Python/worker runtime;
5. shape and texture health are green;
6. first model use may download Hugging Face weights;
7. installing a newer setup over the existing app preserves runtime and model caches.
