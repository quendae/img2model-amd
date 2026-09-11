param(
    [ValidateSet("stable", "nightly")]
    [string]$Channel = "stable",

    [string]$PythonVersion = "3.11",

    [string]$RuntimeDir = "",

    [string]$HunyuanRef = "main"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path

if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
    $RuntimeDir = Join-Path $RepoRoot ".runtime\native-rocm"
}

$RuntimeDir = [System.IO.Path]::GetFullPath($RuntimeDir)
$PythonExe = Join-Path $RuntimeDir "Scripts\python.exe"
$Worker = Join-Path $RepoRoot "backends\hunyuan\worker.py"
$BaseRequirements = Join-Path $RepoRoot "backends\hunyuan\requirements-base.txt"

switch ($Channel) {
    "stable"  { $IndexUrl = "https://stable.repo.amd.com/rocm/whl-next/" }
    "nightly" { $IndexUrl = "https://nightly.repo.amd.com/rocm/whl-next/" }
}

Write-Host "Img2Model AMD native ROCm setup" -ForegroundColor Cyan
Write-Host "  Channel : $Channel"
Write-Host "  Index   : $IndexUrl"
Write-Host "  Target  : gfx1030 (RX 6950 XT / Navi 21 family)"
Write-Host "  Runtime : $RuntimeDir"
Write-Host ""

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
    throw "Python Launcher (py.exe) was not found. Install Python $PythonVersion x64 and rerun this script."
}

if (-not (Test-Path $PythonExe)) {
    Write-Host "[1/6] Creating Python $PythonVersion virtual environment..."
    & py "-$PythonVersion" -m venv $RuntimeDir
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create the Python virtual environment."
    }
} else {
    Write-Host "[1/6] Reusing existing virtual environment."
}

Write-Host "[2/6] Updating packaging tools..."
& $PythonExe -m pip install --upgrade pip setuptools wheel
if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed." }

Write-Host "[3/6] Installing AMD ROCm runtime and PyTorch for gfx1030..."
& $PythonExe -m pip install --index-url $IndexUrl `
    "rocm[libraries,devel,device-gfx1030]" `
    "torch[device-gfx1030]"
if ($LASTEXITCODE -ne 0) {
    throw "ROCm/PyTorch installation failed. Try -Channel nightly if stable does not yet contain a compatible gfx1030 build."
}

Write-Host "[4/6] Installing lightweight Img2Model worker dependencies..."
& $PythonExe -m pip install -r $BaseRequirements
if ($LASTEXITCODE -ne 0) { throw "Worker dependency installation failed." }

Write-Host "[5/6] Installing Hunyuan3D-2 Python package..."
$HunyuanArchive = "https://github.com/Tencent-Hunyuan/Hunyuan3D-2/archive/refs/heads/$HunyuanRef.zip"
& $PythonExe -m pip install $HunyuanArchive
if ($LASTEXITCODE -ne 0) {
    throw "Hunyuan3D-2 installation failed."
}

Write-Host "[6/6] Verifying HIP, PyTorch and Hunyuan imports..."
$VerifyCode = @'
import json
import torch
from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

payload = {
    "torch": torch.__version__,
    "hip": getattr(torch.version, "hip", None),
    "cuda_namespace_available": torch.cuda.is_available(),
    "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
}
print(json.dumps(payload, indent=2))
if not payload["hip"]:
    raise SystemExit("PyTorch loaded, but torch.version.hip is empty. This is not an ROCm build.")
if not payload["cuda_namespace_available"]:
    raise SystemExit("ROCm PyTorch did not expose an available GPU device.")
'@

& $PythonExe -c $VerifyCode
if ($LASTEXITCODE -ne 0) {
    throw "ROCm verification failed. The runtime was installed but is not usable on this machine."
}

Write-Host ""
Write-Host "Worker health:" -ForegroundColor Cyan
& $PythonExe $Worker health --json

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "For the current PowerShell session run:"
Write-Host ('  $env:IMG2MODEL_PYTHON="{0}"' -f $PythonExe) -ForegroundColor Yellow
Write-Host "Then start the app from the repository root with:"
Write-Host "  npm install"
Write-Host "  npm run tauri -- dev"
Write-Host ""
Write-Host "The first generation downloads Hunyuan model weights from Hugging Face."
