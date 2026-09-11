param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath,

    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $RepoRoot "dist-portable\Img2ModelAMD"
}

$ExePath = [System.IO.Path]::GetFullPath($ExePath)
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)

if (-not (Test-Path $ExePath)) {
    throw "Desktop executable does not exist: $ExePath"
}

$RequiredFiles = @(
    "scripts\setup\windows-native-rocm.ps1",
    "scripts\smoke\windows-native-rocm.ps1",
    "backends\hunyuan\worker.py",
    "backends\hunyuan\requirements-base.txt",
    "README.md"
)

foreach ($RelativePath in $RequiredFiles) {
    $Source = Join-Path $RepoRoot $RelativePath
    if (-not (Test-Path $Source)) {
        throw "Required portable file is missing: $Source"
    }
}

if (Test-Path $OutputDir) {
    Remove-Item -Recurse -Force $OutputDir
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Copy-Item -Force $ExePath (Join-Path $OutputDir "Img2ModelAMD.exe")
Copy-Item -Force (Join-Path $RepoRoot "README.md") (Join-Path $OutputDir "README.md")

$SetupDir = Join-Path $OutputDir "scripts\setup"
$SmokeDir = Join-Path $OutputDir "scripts\smoke"
$BackendDir = Join-Path $OutputDir "backends\hunyuan"
New-Item -ItemType Directory -Force -Path $SetupDir | Out-Null
New-Item -ItemType Directory -Force -Path $SmokeDir | Out-Null
New-Item -ItemType Directory -Force -Path $BackendDir | Out-Null

Copy-Item -Force (Join-Path $RepoRoot "scripts\setup\windows-native-rocm.ps1") (Join-Path $SetupDir "windows-native-rocm.ps1")
Copy-Item -Force (Join-Path $RepoRoot "scripts\smoke\windows-native-rocm.ps1") (Join-Path $SmokeDir "windows-native-rocm.ps1")
Copy-Item -Force (Join-Path $RepoRoot "backends\hunyuan\worker.py") (Join-Path $BackendDir "worker.py")
Copy-Item -Force (Join-Path $RepoRoot "backends\hunyuan\requirements-base.txt") (Join-Path $BackendDir "requirements-base.txt")

$Launcher = @'
@echo off
setlocal
cd /d "%~dp0"
start "Img2Model AMD" "%~dp0Img2ModelAMD.exe"
'@
Set-Content -Path (Join-Path $OutputDir "run-img2model-amd.cmd") -Value $Launcher -Encoding ASCII

$SetupLauncher = @'
@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup\windows-native-rocm.ps1"
pause
'@
Set-Content -Path (Join-Path $OutputDir "setup-amd-runtime.cmd") -Value $SetupLauncher -Encoding ASCII

$SmokeLauncher = @'
@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\smoke\windows-native-rocm.ps1"
pause
'@
Set-Content -Path (Join-Path $OutputDir "smoke-test-amd.cmd") -Value $SmokeLauncher -Encoding ASCII

$ExpectedOutputs = @(
    "Img2ModelAMD.exe",
    "README.md",
    "run-img2model-amd.cmd",
    "setup-amd-runtime.cmd",
    "smoke-test-amd.cmd",
    "scripts\setup\windows-native-rocm.ps1",
    "scripts\smoke\windows-native-rocm.ps1",
    "backends\hunyuan\worker.py",
    "backends\hunyuan\requirements-base.txt"
)

foreach ($RelativePath in $ExpectedOutputs) {
    $PackagedPath = Join-Path $OutputDir $RelativePath
    if (-not (Test-Path $PackagedPath)) {
        throw "Portable package verification failed; missing: $PackagedPath"
    }
}

$ExeInfo = Get-Item (Join-Path $OutputDir "Img2ModelAMD.exe")
if ($ExeInfo.Length -le 0) {
    throw "Portable executable is empty."
}

Write-Host "Portable package ready: $OutputDir" -ForegroundColor Green
Write-Host "Executable size: $([Math]::Round($ExeInfo.Length / 1MB, 2)) MB"
