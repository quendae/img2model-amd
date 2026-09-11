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
$HealthLines = @(& $PythonExe $Worker health --json)
$HealthExitCode = $LASTEXITCODE
$HealthLines | ForEach-Object { Write-Host $_ }
if ($HealthExitCode -ne 0) {
    throw "Worker health command failed with exit code $HealthExitCode."
}

$HealthJson = $HealthLines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1
if ([string]::IsNullOrWhiteSpace($HealthJson)) {
    throw "Worker health command returned no JSON output."
}

try {
    $Health = $HealthJson | ConvertFrom-Json
} catch {
    throw "Worker health output was not valid JSON: $HealthJson"
}

if (-not $Health.ok) {
    $Details = if ([string]::IsNullOrWhiteSpace([string]$Health.error)) { "health reported ok=false" } else { [string]$Health.error }
    throw "Worker health check failed: $Details"
}

Write-Host "[2/3] HIP/GPU tensor probe..."
& $PythonExe $Worker probe --json
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
