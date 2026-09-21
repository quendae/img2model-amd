param(
    [string]$PayloadRoot = "",
    [ValidateSet("stable", "nightly")]
    [string]$Channel = "stable",
    [switch]$VerifyOnly,
    [switch]$ForceRepair
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($PayloadRoot)) {
    $PayloadRoot = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
} else {
    $PayloadRoot = [System.IO.Path]::GetFullPath($PayloadRoot)
}

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "LOCALAPPDATA is unavailable; Img2Model AMD cannot create its per-user runtime."
}

$RuntimeDir = Join-Path $env:LOCALAPPDATA "Img2ModelAMD\runtime\native-rocm"
$LogDir = Join-Path $env:LOCALAPPDATA "Img2ModelAMD\logs"
$LogPath = Join-Path $LogDir "installer-runtime.log"
$NativeSetup = Join-Path $PayloadRoot "scripts\setup\windows-native-rocm.ps1"
$TextureSetup = Join-Path $PayloadRoot "scripts\setup\windows-hunyuan-texture.ps1"
$RepaintRequirements = Join-Path $PayloadRoot "backends\hunyuan\requirements-repaint.txt"
$PythonExe = Join-Path $RuntimeDir "Scripts\python.exe"
$InstalledWorker = Join-Path $RuntimeDir "worker.py"
$InstalledWorkerBase = Join-Path $RuntimeDir "worker_base.py"
$InstalledTextureStylizer = Join-Path $RuntimeDir "texture_stylizer.py"
$InstalledLocalRepaint = Join-Path $RuntimeDir "local_repaint.py"
$InstalledBackendsRoot = Join-Path $RuntimeDir "backends"
$InstalledMeshProcessing = Join-Path $InstalledBackendsRoot "mesh_processing"
$WorkerSource = Join-Path $PayloadRoot "backends\hunyuan\worker.py"
$WorkerBaseSource = Join-Path $PayloadRoot "backends\hunyuan\worker_base.py"
$TextureStylizerSource = Join-Path $PayloadRoot "backends\hunyuan\texture_stylizer.py"
$LocalRepaintSource = Join-Path $PayloadRoot "backends\hunyuan\local_repaint.py"
$MeshProcessingSource = Join-Path $PayloadRoot "backends\mesh_processing"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Assert-File([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label was not found in the installer payload: $Path"
    }
}

function Test-WorkerHealth([string]$CommandName) {
    if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath $InstalledWorker -PathType Leaf)) { return $false }

    try {
        $PreviousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $Lines = @(& $PythonExe $InstalledWorker $CommandName --json 2>$null)
            $ExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $PreviousErrorActionPreference
        }
        if ($ExitCode -ne 0) { return $false }
        $JsonLine = $Lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1
        if ([string]::IsNullOrWhiteSpace([string]$JsonLine)) { return $false }
        $Result = $JsonLine | ConvertFrom-Json
        return [bool]$Result.ok
    } catch {
        return $false
    }
}

function Test-ExistingRuntimeHealth {
    if (-not (Test-WorkerHealth "health")) { return $false }
    if (-not (Test-WorkerHealth "texture-health")) { return $false }

    try {
        $PreviousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            & $PythonExe -c "import pymeshlab, manifold3d" 2>$null
            $DependencyExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $PreviousErrorActionPreference
        }
        return $DependencyExitCode -eq 0
    } catch {
        return $false
    }
}

function Test-RepaintDependencies {
    if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) { return $false }
    try {
        $PreviousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            & $PythonExe -c "import diffusers, transformers, accelerate, safetensors" 2>$null
            $DependencyExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $PreviousErrorActionPreference
        }
        return $DependencyExitCode -eq 0
    } catch {
        return $false
    }
}

function Install-RepaintDependencies {
    Assert-File $RepaintRequirements "Local Repaint Python requirements"
    Write-Host "Installing missing Local Repaint Python dependencies..." -ForegroundColor Cyan
    & $PythonExe -m pip install --upgrade-strategy only-if-needed -r $RepaintRequirements
    if ($LASTEXITCODE -ne 0) {
        throw "Local Repaint dependency installation failed with exit code $LASTEXITCODE."
    }
    if (-not (Test-RepaintDependencies)) {
        throw "Local Repaint dependencies are still unavailable after installation."
    }
}

function Sync-RuntimeSources {
    Assert-File $WorkerSource "Bundled Img2Model worker"
    Assert-File $WorkerBaseSource "Bundled Img2Model worker base"
    Assert-File $TextureStylizerSource "Bundled texture stylizer"
    Assert-File $LocalRepaintSource "Bundled Local Repaint backend"
    if (-not (Test-Path -LiteralPath $MeshProcessingSource -PathType Container)) {
        throw "Bundled mesh processing backend was not found: $MeshProcessingSource"
    }

    Copy-Item -Force $WorkerSource $InstalledWorker
    Copy-Item -Force $WorkerBaseSource $InstalledWorkerBase
    Copy-Item -Force $TextureStylizerSource $InstalledTextureStylizer
    Copy-Item -Force $LocalRepaintSource $InstalledLocalRepaint
    New-Item -ItemType Directory -Force -Path $InstalledBackendsRoot | Out-Null
    Set-Content -Path (Join-Path $InstalledBackendsRoot "__init__.py") -Value "" -Encoding utf8
    if (Test-Path -LiteralPath $InstalledMeshProcessing) {
        Remove-Item -Recurse -Force $InstalledMeshProcessing
    }
    Copy-Item -Recurse -Force $MeshProcessingSource $InstalledMeshProcessing
}

function Persist-RuntimeEnvironment {
    $env:IMG2MODEL_PYTHON = $PythonExe
    $env:IMG2MODEL_WORKER = $InstalledWorker
    [Environment]::SetEnvironmentVariable("IMG2MODEL_PYTHON", $PythonExe, "User")
    [Environment]::SetEnvironmentVariable("IMG2MODEL_WORKER", $InstalledWorker, "User")
}

function Resolve-VsDevCmd {
    if (Get-Command cl.exe -ErrorAction SilentlyContinue) {
        return $null
    }

    $VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $VsWhere -PathType Leaf)) {
        return $null
    }

    $InstallPath = (& $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -Last 1)
    if ([string]::IsNullOrWhiteSpace([string]$InstallPath)) {
        return $null
    }

    $Candidate = Join-Path $InstallPath "Common7\Tools\VsDevCmd.bat"
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
        return $Candidate
    }
    return $null
}

function Invoke-TextureSetup([string]$VsDevCmd) {
    if ([string]::IsNullOrWhiteSpace($VsDevCmd)) {
        & $TextureSetup -PythonExe $PythonExe -RuntimeDir $RuntimeDir
        if ($LASTEXITCODE -ne 0) {
            throw "Hunyuan texture setup failed with exit code $LASTEXITCODE."
        }
        return
    }

    $CommandLine = 'call "{0}" -arch=x64 -host_arch=x64 >nul && powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{1}" -PythonExe "{2}" -RuntimeDir "{3}"' -f `
        $VsDevCmd, $TextureSetup, $PythonExe, $RuntimeDir
    & cmd.exe /d /s /c $CommandLine
    if ($LASTEXITCODE -ne 0) {
        throw "Hunyuan texture setup failed with exit code $LASTEXITCODE."
    }
}

function Assert-Health([string]$CommandName) {
    $Lines = @(& $PythonExe $InstalledWorker $CommandName --json)
    $ExitCode = $LASTEXITCODE
    $Lines | ForEach-Object { Write-Host $_ }
    if ($ExitCode -ne 0) {
        throw "Worker $CommandName check failed with exit code $ExitCode."
    }
    $JsonLine = $Lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1
    if ([string]::IsNullOrWhiteSpace([string]$JsonLine)) {
        throw "Worker $CommandName check returned no JSON output."
    }
    $Result = $JsonLine | ConvertFrom-Json
    if (-not $Result.ok) {
        throw "Worker $CommandName check reported ok=false: $($Result.error)"
    }
}

Assert-File $NativeSetup "Native ROCm setup script"
Assert-File $TextureSetup "Hunyuan texture setup script"
Assert-File $RepaintRequirements "Local Repaint Python requirements"
Assert-File $LocalRepaintSource "Bundled Local Repaint backend"

Write-Host "Img2Model AMD runtime installer" -ForegroundColor Cyan
Write-Host "  Payload : $PayloadRoot"
Write-Host "  Runtime : $RuntimeDir"
Write-Host "  Channel : $Channel"
Write-Host "  Verify  : $VerifyOnly"
Write-Host "  Repair  : $ForceRepair"
Write-Host "  Log     : $LogPath"
Write-Host ""

$TranscriptStarted = $false
try {
    Start-Transcript -LiteralPath $LogPath -Append | Out-Null
    $TranscriptStarted = $true

    $ExistingRuntimeHealthy = Test-ExistingRuntimeHealth
    if ($ExistingRuntimeHealthy -and -not $ForceRepair) {
        Write-Host "Reusing healthy existing Img2Model AMD runtime; refreshing version-matched worker sources only." -ForegroundColor Green
        Sync-RuntimeSources

        if (-not (Test-RepaintDependencies)) {
            if ($VerifyOnly) {
                throw "Existing Img2Model AMD runtime is healthy but Local Repaint dependencies are missing. VerifyOnly does not modify the runtime."
            }
            Install-RepaintDependencies
        }

        if ((Test-ExistingRuntimeHealth) -and (Test-RepaintDependencies)) {
            Persist-RuntimeEnvironment
            Write-Host "Existing runtime remains healthy after worker and Local Repaint refresh." -ForegroundColor Green
            Write-Host "Native Radeon and Hunyuan Paint components were reused; model and Hugging Face caches were left untouched."
            exit 0
        }

        Write-Host "Existing runtime needs maintenance after the worker refresh; continuing with repair." -ForegroundColor Yellow
    }

    if ($VerifyOnly) {
        throw "Existing Img2Model AMD runtime is not healthy. VerifyOnly does not modify the runtime; rerun setup without -VerifyOnly to repair it."
    }

    Write-Host "Repairing/installing persistent Radeon runtime..." -ForegroundColor Cyan

    $PyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($null -eq $PyLauncher) {
        throw "Python 3.11 x64 with the Windows py.exe launcher is required. Install Python 3.11 x64, enable the Python Launcher, then run Img2Model AMD setup again."
    }
    & py.exe -3.11 -c "import sys; raise SystemExit(0 if sys.maxsize > 2**32 else 1)"
    if ($LASTEXITCODE -ne 0) {
        throw "Python 3.11 x64 is required. The installed Python 3.11 interpreter is missing or is not 64-bit."
    }

    $VsDevCmd = Resolve-VsDevCmd
    if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue) -and [string]::IsNullOrWhiteSpace([string]$VsDevCmd)) {
        throw "Microsoft Visual Studio C++ build tools are required for Hunyuan Paint. Install Visual Studio 2022 Build Tools with the Desktop development with C++ workload, then run Img2Model AMD setup again."
    }

    & $NativeSetup -Channel $Channel -RuntimeDir $RuntimeDir
    if ($LASTEXITCODE -ne 0) {
        throw "Native Radeon runtime setup failed with exit code $LASTEXITCODE."
    }
    Invoke-TextureSetup $VsDevCmd
    Sync-RuntimeSources
    Install-RepaintDependencies

    Assert-File $PythonExe "Installed Python runtime"
    Assert-File $InstalledWorker "Installed Img2Model worker"
    Assert-File $InstalledLocalRepaint "Installed Local Repaint backend"
    Assert-Health "health"
    Assert-Health "texture-health"
    if (-not (Test-RepaintDependencies)) {
        throw "Local Repaint dependency verification failed."
    }
    Persist-RuntimeEnvironment

    Write-Host ""
    Write-Host "Img2Model AMD runtime setup completed successfully." -ForegroundColor Green
    Write-Host "Model weights are not bundled; they will download on first use and are preserved independently of app updates."
    exit 0
} catch {
    Write-Host ""
    Write-Host "Img2Model AMD runtime setup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Full setup log: $LogPath" -ForegroundColor Yellow
    exit 1
} finally {
    if ($TranscriptStarted) {
        Stop-Transcript | Out-Null
    }
}
