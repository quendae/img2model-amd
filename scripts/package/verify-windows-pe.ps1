param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ExePath = [System.IO.Path]::GetFullPath($ExePath)
if (-not (Test-Path $ExePath)) {
    throw "Executable does not exist: $ExePath"
}

$Bytes = [System.IO.File]::ReadAllBytes($ExePath)
if ($Bytes.Length -lt 256) {
    throw "Executable is too small to be a valid PE file: $ExePath"
}

if ($Bytes[0] -ne 0x4D -or $Bytes[1] -ne 0x5A) {
    throw "Missing MZ header: $ExePath"
}

$PeOffset = [BitConverter]::ToInt32($Bytes, 0x3C)
if ($PeOffset -lt 0 -or ($PeOffset + 24) -ge $Bytes.Length) {
    throw "Invalid PE header offset: $PeOffset"
}

if ($Bytes[$PeOffset] -ne 0x50 -or
    $Bytes[$PeOffset + 1] -ne 0x45 -or
    $Bytes[$PeOffset + 2] -ne 0x00 -or
    $Bytes[$PeOffset + 3] -ne 0x00) {
    throw "Missing PE signature: $ExePath"
}

$OptionalHeaderOffset = $PeOffset + 4 + 20
$Magic = [BitConverter]::ToUInt16($Bytes, $OptionalHeaderOffset)
if ($Magic -ne 0x10B -and $Magic -ne 0x20B) {
    throw ('Unsupported PE optional-header magic: 0x{0:X4}' -f $Magic)
}

# IMAGE_OPTIONAL_HEADER32/64 places Subsystem at offset 0x44.
$Subsystem = [BitConverter]::ToUInt16($Bytes, $OptionalHeaderOffset + 0x44)
$SubsystemNames = @{
    2 = 'Windows GUI'
    3 = 'Windows Console'
}
$SubsystemName = if ($SubsystemNames.ContainsKey([int]$Subsystem)) {
    $SubsystemNames[[int]$Subsystem]
} else {
    "Other ($Subsystem)"
}

Write-Host "PE subsystem: $SubsystemName [$Subsystem]"

if ($Subsystem -ne 2) {
    throw "Portable desktop executable must use the Windows GUI subsystem (2), got $SubsystemName [$Subsystem]."
}

Write-Host "Windows PE verification passed." -ForegroundColor Green
