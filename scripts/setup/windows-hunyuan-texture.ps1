param(
    [string]$PythonExe = $env:IMG2MODEL_PYTHON,
    [string]$RuntimeDir = "",
    [string]$HunyuanRef = "f8db63096c8282cb27354314d896feba5ba6ff8a",
    [string]$GpuArch = "gfx1030",
    [switch]$ForceRebuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$WorkerSource = Join-Path $RepoRoot "backends\hunyuan\worker.py"

if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
    if (-not [string]::IsNullOrWhiteSpace($PythonExe)) {
        $RuntimeDir = Split-Path -Parent (Split-Path -Parent ([System.IO.Path]::GetFullPath($PythonExe)))
    } elseif (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $RuntimeDir = Join-Path $env:LOCALAPPDATA "Img2ModelAMD\runtime\native-rocm"
    } else {
        throw "LOCALAPPDATA is not available; pass -RuntimeDir or -PythonExe explicitly."
    }
}

$RuntimeDir = [System.IO.Path]::GetFullPath($RuntimeDir)
if ([string]::IsNullOrWhiteSpace($PythonExe)) {
    $PythonExe = Join-Path $RuntimeDir "Scripts\python.exe"
}
$PythonExe = [System.IO.Path]::GetFullPath($PythonExe)
$PythonScripts = Split-Path -Parent $PythonExe
$InstalledWorker = Join-Path $RuntimeDir "worker.py"
$SourceRoot = Join-Path $RuntimeDir "texture-build\hunyuan-src"
$ArchivePath = Join-Path $RuntimeDir "texture-build\hunyuan.zip"
$ExtractRoot = Join-Path $RuntimeDir "texture-build\extract"
$LogDir = Join-Path $RuntimeDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogPath = Join-Path $LogDir ("texture-setup-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))

function Assert-File([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label does not exist: $Path"
    }
}

function Add-LogLine([string]$Line) {
    Add-Content -LiteralPath $LogPath -Value $Line -Encoding UTF8
}

function Show-LogTail {
    if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
        Write-Host ""
        Write-Host "Last 80 log lines:" -ForegroundColor Yellow
        Get-Content -LiteralPath $LogPath -Tail 80 | ForEach-Object { Write-Host $_ }
    }
    Write-Host ""
    Write-Host "Full log: $LogPath" -ForegroundColor Yellow
}

function Invoke-Checked([string]$Label, [scriptblock]$Command) {
    Write-Host $Label -ForegroundColor Cyan
    Add-LogLine ""
    Add-LogLine ("==== {0} ====" -f $Label)
    Add-LogLine ("Started: {0:o}" -f (Get-Date))

    & $Command 2>&1 | Tee-Object -FilePath $LogPath -Append | Out-Null
    $ExitCode = $LASTEXITCODE
    Add-LogLine ("Exit code: {0}" -f $ExitCode)

    if ($ExitCode -ne 0) {
        Show-LogTail
        throw "$Label failed with exit code $ExitCode."
    }

    Write-Host "  OK" -ForegroundColor Green
}

Assert-File $PythonExe "Img2Model Python runtime"
Assert-File $WorkerSource "Img2Model worker source"

$HeaderLines = @(
    "Img2Model AMD Hunyuan texture setup",
    "Started     : $((Get-Date).ToString('o'))",
    "Python      : $PythonExe",
    "Runtime     : $RuntimeDir",
    "Hunyuan ref : $HunyuanRef",
    "GPU arch    : $GpuArch",
    "Full log    : $LogPath"
)
Set-Content -LiteralPath $LogPath -Value $HeaderLines -Encoding UTF8

Write-Host "Img2Model AMD Hunyuan texture setup" -ForegroundColor Cyan
Write-Host "  Python     : $PythonExe"
Write-Host "  Runtime    : $RuntimeDir"
Write-Host "  Hunyuan ref: $HunyuanRef"
Write-Host "  GPU arch   : $GpuArch"
Write-Host "  Full log   : $LogPath" -ForegroundColor Yellow
Write-Host ""

$TorchInfo = @(& $PythonExe -c "import json, torch; from torch.utils.cpp_extension import ROCM_HOME, IS_HIP_EXTENSION; print(json.dumps({'torch':torch.__version__,'hip':getattr(torch.version,'hip',None),'rocm_home':ROCM_HOME,'is_hip_extension':bool(IS_HIP_EXTENSION)}))")
if ($LASTEXITCODE -ne 0 -or $TorchInfo.Count -eq 0) {
    Show-LogTail
    throw "Unable to inspect the installed ROCm PyTorch runtime. Run windows-native-rocm.ps1 first."
}
$TorchJson = $TorchInfo | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1
$Torch = $TorchJson | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$Torch.hip)) {
    throw "Installed PyTorch is not an ROCm build (torch.version.hip is empty)."
}
if (-not $Torch.is_hip_extension) {
    throw "PyTorch did not enable HIP extension compilation. ROCM_HOME=$($Torch.rocm_home)"
}
if ([string]::IsNullOrWhiteSpace([string]$Torch.rocm_home)) {
    throw "PyTorch could not locate ROCM_HOME from the TheRock runtime."
}

$RocmHome = [System.IO.Path]::GetFullPath([string]$Torch.rocm_home)
$env:ROCM_HOME = $RocmHome
$env:ROCM_PATH = $RocmHome
$env:PYTORCH_ROCM_ARCH = $GpuArch
$env:PATH = $PythonScripts + ";" + (Join-Path $RocmHome "bin") + ";" + $env:PATH

$HipccPath = Get-Command hipcc.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue
$ClangPath = Get-Command clang++.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue
$ClPath = Get-Command cl.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue

Write-Host "ROCm extension compiler diagnostics:" -ForegroundColor Cyan
Write-Host "  torch        : $($Torch.torch)"
Write-Host "  HIP          : $($Torch.hip)"
Write-Host "  ROCM_HOME    : $RocmHome"
Write-Host "  HIP extension: $($Torch.is_hip_extension)"
Write-Host "  hipcc        : $HipccPath"
Write-Host "  clang++      : $ClangPath"
Write-Host "  cl.exe       : $ClPath"
Write-Host ""

Add-LogLine ""
Add-LogLine "ROCm extension compiler diagnostics:"
Add-LogLine ("torch         : {0}" -f $Torch.torch)
Add-LogLine ("HIP           : {0}" -f $Torch.hip)
Add-LogLine ("ROCM_HOME     : {0}" -f $RocmHome)
Add-LogLine ("HIP extension : {0}" -f $Torch.is_hip_extension)
Add-LogLine ("hipcc         : {0}" -f $HipccPath)
Add-LogLine ("clang++       : {0}" -f $ClangPath)
Add-LogLine ("cl.exe        : {0}" -f $ClPath)

# PyTorch 2.13's Windows ROCm extension path is substantially more reliable with
# Ninja. In particular, the distutils fallback observed on the RX 6950 XT omitted
# the C++20 language flag required by current PyTorch headers.
Invoke-Checked "Installing/upgrading Ninja build backend..." {
    & $PythonExe -m pip install --upgrade ninja
}
$NinjaPath = Get-Command ninja.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue
if ([string]::IsNullOrWhiteSpace([string]$NinjaPath)) {
    Show-LogTail
    throw "Ninja was installed into the runtime but ninja.exe is still not visible on PATH: $PythonScripts"
}
Write-Host "  Ninja build backend: $NinjaPath"
Add-LogLine ("Ninja build backend: {0}" -f $NinjaPath)
Write-Host ""

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ArchivePath) | Out-Null

if ($ForceRebuild -or -not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
    if (Test-Path -LiteralPath $ExtractRoot) {
        Remove-Item -Recurse -Force $ExtractRoot
    }
    New-Item -ItemType Directory -Force -Path $ExtractRoot | Out-Null

    $ArchiveUrl = "https://github.com/Tencent-Hunyuan/Hunyuan3D-2/archive/$HunyuanRef.zip"
    Write-Host "Downloading Hunyuan3D-2 source for texture extension build..." -ForegroundColor Cyan
    Add-LogLine ("Downloading Hunyuan source: {0}" -f $ArchiveUrl)
    Invoke-WebRequest -Uri $ArchiveUrl -OutFile $ArchivePath -UseBasicParsing

    Write-Host "Extracting texture build sources..." -ForegroundColor Cyan
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractRoot -Force
    $ExtractedDir = Get-ChildItem -LiteralPath $ExtractRoot -Directory | Select-Object -First 1
    if ($null -eq $ExtractedDir) {
        Show-LogTail
        throw "Hunyuan source archive did not contain an extracted directory."
    }

    if (Test-Path -LiteralPath $SourceRoot) {
        Remove-Item -Recurse -Force $SourceRoot
    }
    Move-Item -LiteralPath $ExtractedDir.FullName -Destination $SourceRoot
}

$CustomRasterizer = Join-Path $SourceRoot "hy3dgen\texgen\custom_rasterizer"
$DifferentiableRenderer = Join-Path $SourceRoot "hy3dgen\texgen\differentiable_renderer"
Assert-File (Join-Path $CustomRasterizer "setup.py") "custom_rasterizer setup.py"
Assert-File (Join-Path $DifferentiableRenderer "setup.py") "differentiable_renderer setup.py"

Copy-Item -Force $WorkerSource $InstalledWorker

# The upstream custom_rasterizer setup.py does not specify a language standard.
# PyTorch 2.13 headers require C++20. Force it for MSVC even if BuildExtension
# unexpectedly falls back from Ninja again; restore the user's CL afterwards.
$PreviousCl = [Environment]::GetEnvironmentVariable("CL", "Process")
try {
    if ([string]::IsNullOrWhiteSpace($PreviousCl)) {
        $env:CL = "/std:c++20"
    } elseif ($PreviousCl -notmatch "(^|\s)/std:c\+\+(20|latest)(\s|$)") {
        $env:CL = "/std:c++20 $PreviousCl"
    }
    Add-LogLine ("CL for custom_rasterizer: {0}" -f $env:CL)

    Push-Location $CustomRasterizer
    try {
        Invoke-Checked "Building custom_rasterizer through PyTorch ROCm/HIPify..." {
            & $PythonExe -m pip install --no-build-isolation --force-reinstall --no-deps .
        }
    } finally {
        Pop-Location
    }
} finally {
    if ($null -eq $PreviousCl) {
        Remove-Item Env:CL -ErrorAction SilentlyContinue
    } else {
        $env:CL = $PreviousCl
    }
}

Push-Location $DifferentiableRenderer
try {
    Invoke-Checked "Building differentiable_renderer mesh_processor extension..." {
        & $PythonExe -m pip install --no-build-isolation --force-reinstall --no-deps .
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Texture runtime health:" -ForegroundColor Cyan
$HealthLines = @(& $PythonExe $InstalledWorker texture-health --json 2>&1 | Tee-Object -FilePath $LogPath -Append)
$HealthExitCode = $LASTEXITCODE
if ($HealthExitCode -ne 0) {
    Show-LogTail
    throw "Texture health command failed with exit code $HealthExitCode."
}
$HealthLines | ForEach-Object { Write-Host $_ }
$HealthJson = $HealthLines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1
if ([string]::IsNullOrWhiteSpace($HealthJson)) {
    Show-LogTail
    throw "Texture health returned no JSON output."
}
$Health = $HealthJson | ConvertFrom-Json
if (-not $Health.ok) {
    Show-LogTail
    throw "Texture runtime is not healthy after extension build: $($Health.error)"
}

Write-Host ""
Write-Host "Hunyuan texture runtime is ready." -ForegroundColor Green
Write-Host "The existing shape runtime was preserved; only texture extensions were added."
Write-Host "Recommended first texture run uses --cpu-offload on 16 GB VRAM."
Write-Host "Full log: $LogPath" -ForegroundColor Yellow
Add-LogLine ("Completed successfully: {0:o}" -f (Get-Date))
