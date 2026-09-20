param(
    [string]$PayloadRoot = "",
    [ValidateSet("stable", "nightly")]
    [string]$Channel = "stable",
    [switch]$VerifyOnly
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
$PythonExe = Join-Path $RuntimeDir "Scripts\python.exe"
$InstalledWorker = Join-Path $RuntimeDir "worker.py"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Assert-File([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label was not found in the installer payload: $Path"
    }
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

$PyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
if ($null -eq $PyLauncher) {
    throw "Python 3.11 x64 with the Windows py.exe launcher is required. Install Python 3.11 x64, enable the Python Launcher, then run Img2Model AMD setup again."
}
& py.exe -3.11 -c "import sys; raise SystemExit(0 if sys.maxsize > 2**32 else 1)"
if ($LASTEXITCODE -ne 0) {
    throw "Python 3.11 x64 is required. The installed Python 3.11 interpreter is missing or is not 64-bit."
}

$VsDevCmd = Resolve-VsDevCmd
if (-not $VerifyOnly -and -not (Get-Command cl.exe -ErrorAction SilentlyContinue) -and [string]::IsNullOrWhiteSpace([string]$VsDevCmd)) {
    throw "Microsoft Visual Studio C++ build tools are required for Hunyuan Paint. Install Visual Studio 2022 Build Tools with the Desktop development with C++ workload, then run Img2Model AMD setup again."
}

Write-Host "Img2Model AMD runtime installer" -ForegroundColor Cyan
Write-Host "  Payload : $PayloadRoot"
Write-Host "  Runtime : $RuntimeDir"
Write-Host "  Channel : $Channel"
Write-Host "  Verify  : $VerifyOnly"
Write-Host "  Log     : $LogPath"
Write-Host ""

$TranscriptStarted = $false
try {
    Start-Transcript -LiteralPath $LogPath -Append | Out-Null
    $TranscriptStarted = $true

    if ($VerifyOnly) {
        & $NativeSetup -Channel $Channel -RuntimeDir $RuntimeDir -VerifyOnly
    } else {
        & $NativeSetup -Channel $Channel -RuntimeDir $RuntimeDir
        Invoke-TextureSetup $VsDevCmd
    }

    Assert-File $PythonExe "Installed Python runtime"
    Assert-File $InstalledWorker "Installed Img2Model worker"
    Assert-Health "health"
    Assert-Health "texture-health"

    $env:IMG2MODEL_PYTHON = $PythonExe
    $env:IMG2MODEL_WORKER = $InstalledWorker
    [Environment]::SetEnvironmentVariable("IMG2MODEL_PYTHON", $PythonExe, "User")
    [Environment]::SetEnvironmentVariable("IMG2MODEL_WORKER", $InstalledWorker, "User")

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
