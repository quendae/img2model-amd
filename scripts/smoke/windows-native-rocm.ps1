param(
    [string]$PythonExe = $env:IMG2MODEL_PYTHON,
    [string]$Worker = $env:IMG2MODEL_WORKER,
    [string]$InputImage = "",
    [string]$Output = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-Path([string]$Path, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "$Label is not configured. Run scripts/setup/windows-native-rocm.ps1 first or pass it explicitly."
    }
    if (-not (Test-Path $Path)) {
        throw "$Label does not exist: $Path"
    }
}

Assert-Path $PythonExe "Python runtime"
Assert-Path $Worker "Img2Model worker"

Write-Host "Img2Model AMD native ROCm smoke test" -ForegroundColor Cyan
Write-Host "  Python : $PythonExe"
Write-Host "  Worker : $Worker"
Write-Host ""

Write-Host "[1/3] Worker health..."
& $PythonExe $Worker health --json
if ($LASTEXITCODE -ne 0) {
    throw "Worker health command failed."
}

Write-Host "[2/3] HIP/GPU tensor probe..."
$Probe = @'
import json
import torch

if not getattr(torch.version, "hip", None):
    raise SystemExit("torch.version.hip is empty; this is not an ROCm PyTorch build")
if not torch.cuda.is_available():
    raise SystemExit("ROCm PyTorch does not expose an available GPU")

device = torch.device("cuda")
a = torch.arange(1024 * 1024, dtype=torch.float32, device=device).reshape(1024, 1024)
b = torch.eye(1024, dtype=torch.float32, device=device)
c = a @ b
checksum = float(c[0, 0].item() + c[-1, -1].item())

print(json.dumps({
    "ok": True,
    "torch": torch.__version__,
    "hip": torch.version.hip,
    "device": torch.cuda.get_device_name(0),
    "vram_gb": round(torch.cuda.get_device_properties(0).total_memory / (1024 ** 3), 2),
    "checksum": checksum,
}, indent=2))
'@

& $PythonExe -c $Probe
if ($LASTEXITCODE -ne 0) {
    throw "GPU tensor probe failed."
}

if ([string]::IsNullOrWhiteSpace($InputImage)) {
    Write-Host "[3/3] Hunyuan generation skipped (no -InputImage supplied)." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "ROCm smoke test passed. To test end-to-end generation:" -ForegroundColor Green
    Write-Host '.\scripts\smoke\windows-native-rocm.ps1 -InputImage "C:\path\image.png" -Output "C:\path\model.glb"'
    exit 0
}

Assert-Path $InputImage "Input image"
if ([string]::IsNullOrWhiteSpace($Output)) {
    $Output = Join-Path (Split-Path -Parent ([System.IO.Path]::GetFullPath($InputImage))) "img2model-smoke.glb"
}

$Output = [System.IO.Path]::GetFullPath($Output)
Write-Host "[3/3] End-to-end Hunyuan Mini generation..."
Write-Host "  Input  : $InputImage"
Write-Host "  Output : $Output"

& $PythonExe $Worker generate `
    --input $InputImage `
    --output $Output `
    --model "tencent/Hunyuan3D-2mini" `
    --subfolder "hunyuan3d-dit-v2-mini" `
    --variant "fp16" `
    --steps 20 `
    --seed 1234 `
    --remove-background

if ($LASTEXITCODE -ne 0) {
    throw "End-to-end Hunyuan generation failed."
}
if (-not (Test-Path $Output)) {
    throw "Worker reported success but the output file was not created: $Output"
}

$OutputInfo = Get-Item $Output
if ($OutputInfo.Length -le 0) {
    throw "Generated output is empty: $Output"
}

Write-Host ""
Write-Host "End-to-end smoke test passed." -ForegroundColor Green
Write-Host "Generated: $($OutputInfo.FullName) ($([Math]::Round($OutputInfo.Length / 1MB, 2)) MB)"
