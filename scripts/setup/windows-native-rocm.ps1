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
$InstalledWorker = Join-Path $RuntimeDir "worker.py"
$BaseRequirements = Join-Path $RepoRoot "backends\hunyuan\requirements-base.txt"

switch ($Channel) {
    "stable"  { $IndexUrl = "https://stable.repo.amd.com/rocm/whl-next/" }
    "nightly" { $IndexUrl = "https://nightly.repo.amd.com/rocm/whl-next/" }
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
    Write-Host "[3/7] ROCm/PyTorch install skipped (VerifyOnly)."
    Write-Host "[4/7] Worker dependency install skipped (VerifyOnly)."
    Write-Host "[5/7] Hunyuan3D install skipped (VerifyOnly)."
} else {
    Write-Host "[2/7] Updating packaging tools..."
    & $PythonExe -m pip install --upgrade pip setuptools wheel
    if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed." }

    Write-Host "[3/7] Installing AMD ROCm runtime and PyTorch for gfx1030..."
    & $PythonExe -m pip install --index-url $IndexUrl `
        "rocm[libraries,devel,device-gfx1030]" `
        "torch[device-gfx1030]"
    if ($LASTEXITCODE -ne 0) {
        throw "ROCm/PyTorch installation failed. Try -Channel nightly if stable does not yet contain a compatible gfx1030 build."
    }

    Write-Host "[4/7] Installing lightweight Img2Model worker dependencies..."
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
