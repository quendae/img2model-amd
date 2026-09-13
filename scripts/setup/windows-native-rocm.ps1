param(
    [ValidateSet("stable", "nightly")]
    [string]$Channel = "stable",

    [string]$PythonVersion = "3.11",

    [string]$RuntimeDir = "",

    [string]$HunyuanRef = "main",

    [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path

if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is not available; pass -RuntimeDir explicitly."
    }
    $RuntimeDir = Join-Path $env:LOCALAPPDATA "Img2ModelAMD\runtime\native-rocm"
}

$RuntimeDir = [System.IO.Path]::GetFullPath($RuntimeDir)
$PythonExe = Join-Path $RuntimeDir "Scripts\python.exe"
$WorkerSource = Join-Path $RepoRoot "backends\hunyuan\worker.py"
$WorkerBaseSource = Join-Path $RepoRoot "backends\hunyuan\worker_base.py"
$InstalledWorker = Join-Path $RuntimeDir "worker.py"
$InstalledWorkerBase = Join-Path $RuntimeDir "worker_base.py"
$MeshProcessingSource = Join-Path $RepoRoot "backends\mesh_processing"
$InstalledBackendsRoot = Join-Path $RuntimeDir "backends"
$InstalledMeshProcessing = Join-Path $InstalledBackendsRoot "mesh_processing"
$BaseRequirements = Join-Path $RepoRoot "backends\hunyuan\requirements-base.txt"

switch ($Channel) {
    "stable" {
        $IndexUrl = "https://stable.repo.amd.com/rocm/whl-next/"
        $RocmSpec = "rocm[libraries,devel,device-gfx1030]==10.0.0"
        $TorchSpec = "torch[device-gfx1030]==2.13.0+rocm10.0.0"
        $TorchVisionSpec = "torchvision[device-gfx1030]==0.28.0+rocm10.0.0"
    }
    "nightly" {
        $IndexUrl = "https://nightly.repo.amd.com/rocm/whl-next/"
        $RocmSpec = "rocm[libraries,devel,device-gfx1030]"
        $TorchSpec = "torch[device-gfx1030]"
        $TorchVisionSpec = "torchvision[device-gfx1030]"
    }
}

Write-Host "Img2Model AMD native ROCm setup" -ForegroundColor Cyan
Write-Host "  Channel    : $Channel"
Write-Host "  Index      : $IndexUrl"
Write-Host "  Target     : gfx1030 (RX 6950 XT / Navi 21 family)"
Write-Host "  Runtime    : $RuntimeDir"
Write-Host "  VerifyOnly : $VerifyOnly"
Write-Host ""

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
    throw "Python Launcher (py.exe) was not found. Install Python $PythonVersion x64 and rerun this script."
}

if (-not (Test-Path $PythonExe)) {
    if ($VerifyOnly) {
        throw "VerifyOnly was requested, but the existing runtime was not found: $PythonExe"
    }

    Write-Host "[1/7] Creating Python $PythonVersion virtual environment..."
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RuntimeDir) | Out-Null
    & py "-$PythonVersion" -m venv $RuntimeDir
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create the Python virtual environment."
    }
} else {
    Write-Host "[1/7] Reusing existing virtual environment."
}

if ($VerifyOnly) {
    Write-Host "[2/7] Packaging tools install skipped (VerifyOnly)."
    Write-Host "[3/7] ROCm/PyTorch/torchvision install skipped (VerifyOnly)."
    Write-Host "[4/7] Worker dependency install skipped (VerifyOnly)."
    Write-Host "[5/7] Hunyuan3D install skipped (VerifyOnly)."
} else {
    Write-Host "[2/7] Updating packaging tools..."
    & $PythonExe -m pip install --upgrade pip setuptools wheel
    if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed." }

    Write-Host "[3/7] Installing AMD ROCm, PyTorch and torchvision for gfx1030..."
    & $PythonExe -m pip install --index-url $IndexUrl `
        $RocmSpec `
        $TorchSpec `
        $TorchVisionSpec
    if ($LASTEXITCODE -ne 0) {
        throw "ROCm/PyTorch/torchvision installation failed. Try -Channel nightly if stable does not contain a compatible gfx1030 build."
    }

    Write-Host "[4/7] Installing Img2Model worker and game-ready mesh dependencies..."
    & $PythonExe -m pip install -r $BaseRequirements
    if ($LASTEXITCODE -ne 0) { throw "Worker dependency installation failed." }

    Write-Host "[5/7] Installing Hunyuan3D-2 Python package..."
    $HunyuanArchive = "https://github.com/Tencent-Hunyuan/Hunyuan3D-2/archive/refs/heads/$HunyuanRef.zip"
    & $PythonExe -m pip install $HunyuanArchive
    if ($LASTEXITCODE -ne 0) {
        throw "Hunyuan3D-2 installation failed."
    }
}

Write-Host "[6/7] Installing the Img2Model worker into the persistent runtime..."
Copy-Item -Force $WorkerSource $InstalledWorker
Copy-Item -Force $WorkerBaseSource $InstalledWorkerBase
New-Item -ItemType Directory -Force -Path $InstalledBackendsRoot | Out-Null
Set-Content -Path (Join-Path $InstalledBackendsRoot "__init__.py") -Value "" -Encoding utf8
if (Test-Path $InstalledMeshProcessing) {
    Remove-Item -Recurse -Force $InstalledMeshProcessing
}
Copy-Item -Recurse -Force $MeshProcessingSource $InstalledMeshProcessing

Write-Host "Verifying game-ready mesh dependencies..." -ForegroundColor Cyan
$MeshDependencyProbePath = Join-Path ([System.IO.Path]::GetTempPath()) ("img2model-mesh-deps-{0}.py" -f [Guid]::NewGuid().ToString("N"))
$MeshDependencyProbe = @'
import json
import importlib.metadata as metadata
import pymeshlab
import manifold3d

print(json.dumps({
    "pymeshlab": metadata.version("pymeshlab"),
    "manifold3d": metadata.version("manifold3d"),
}))
'@
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($MeshDependencyProbePath, $MeshDependencyProbe, $Utf8NoBom)
try {
    $MeshDependencyLines = @(& $PythonExe $MeshDependencyProbePath)
    $MeshDependencyExitCode = $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $MeshDependencyProbePath -Force -ErrorAction SilentlyContinue
}
$MeshDependencyLines | ForEach-Object { Write-Host $_ }
if ($MeshDependencyExitCode -ne 0) {
    throw "PyMeshLab / Manifold3D verification failed. Run without -VerifyOnly once to install the pinned game-ready mesh dependencies."
}
$MeshDependencyJson = $MeshDependencyLines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1
if ([string]::IsNullOrWhiteSpace($MeshDependencyJson)) {
    throw "PyMeshLab / Manifold3D verification returned no JSON output."
}
try {
    $MeshDependencies = $MeshDependencyJson | ConvertFrom-Json
} catch {
    throw "PyMeshLab / Manifold3D verification output was not valid JSON: $MeshDependencyJson"
}
Write-Host ("  PyMeshLab : {0}" -f $MeshDependencies.pymeshlab) -ForegroundColor Green
Write-Host ("  Manifold3D: {0}" -f $MeshDependencies.manifold3d) -ForegroundColor Green

Write-Host "[7/7] Verifying HIP, GPU and Hunyuan imports through the worker..."
$HealthLines = @(& $PythonExe $InstalledWorker health --json)
$HealthExitCode = $LASTEXITCODE
$HealthLines | ForEach-Object { Write-Host $_ }
if ($HealthExitCode -ne 0) {
    throw "Img2Model worker health command failed with exit code $HealthExitCode."
}

$HealthJson = $HealthLines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1
if ([string]::IsNullOrWhiteSpace($HealthJson)) {
    throw "Img2Model worker health check returned no JSON output."
}

try {
    $Health = $HealthJson | ConvertFrom-Json
} catch {
    throw "Img2Model worker health output was not valid JSON: $HealthJson"
}

if (-not $Health.ok) {
    $Details = if ([string]::IsNullOrWhiteSpace([string]$Health.error)) { "health reported ok=false" } else { [string]$Health.error }
    throw "ROCm/Hunyuan verification failed: $Details"
}

$env:IMG2MODEL_PYTHON = $PythonExe
$env:IMG2MODEL_WORKER = $InstalledWorker
[Environment]::SetEnvironmentVariable("IMG2MODEL_PYTHON", $PythonExe, "User")
[Environment]::SetEnvironmentVariable("IMG2MODEL_WORKER", $InstalledWorker, "User")

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "Runtime configuration was saved for your Windows user:" -ForegroundColor Cyan
Write-Host ('  IMG2MODEL_PYTHON={0}' -f $PythonExe) -ForegroundColor Yellow
Write-Host ('  IMG2MODEL_WORKER={0}' -f $InstalledWorker) -ForegroundColor Yellow
Write-Host ""
Write-Host "The variables are also active in this PowerShell process. New app processes will read the persisted values."
Write-Host "Next run the smoke test to execute a real tensor operation on the Radeon GPU."
Write-Host "The first full generation downloads Hunyuan model weights from Hugging Face."
