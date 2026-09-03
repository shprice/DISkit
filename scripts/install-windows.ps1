# DISkit Windows Installation Script
# Installs DISkit SEA executable and assets to Program Files or Local AppData

[CmdletBinding()]
param (
    [string]$InstallDir = "$env:LOCALAPPDATA\DISkit"
)

$ErrorActionPreference = "Stop"

Write-Host "=== DISkit Windows Installer ===" -ForegroundColor Cyan
Write-Host "Target Installation Directory: $InstallDir" -ForegroundColor Yellow

# 1. Locate built distribution files
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RootDir = Split-Path -Parent $ScriptDir
$SourceDir = Join-Path $RootDir "dist\diskit-dist"

if (-not (Test-Path $SourceDir)) {
    Write-Error "Build distribution directory not found: $SourceDir`nPlease run 'npm run build:sea' first before installing."
    exit 1
}

# 2. Create installation directory
if (-not (Test-Path $InstallDir)) {
    New-Item -Path $InstallDir -ItemType Directory -Force | Out-Null
}

# 3. Copy application files
Write-Host "Copying executable and assets..." -ForegroundColor Green
Copy-Item -Path "$SourceDir\*" -Destination $InstallDir -Recurse -Force
New-Item -Path (Join-Path $InstallDir "logs") -ItemType Directory -Force | Out-Null

# 4. Create Desktop Shortcut
$DesktopPath = [System.IO.Path]::Combine([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop), "DISkit.lnk")
$ExePath = Join-Path $InstallDir "diskit.exe"

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($DesktopPath)
$Shortcut.TargetPath = $ExePath
$Shortcut.WorkingDirectory = $InstallDir
$Shortcut.Description = "DIS Traffic Logger and Replay Utility"
$Shortcut.Save()

Write-Host "`nInstallation Completed Successfully!" -ForegroundColor Green
Write-Host "Executable Installed To : $ExePath"
Write-Host "Desktop Shortcut Created : $DesktopPath"
Write-Host "`nYou can launch DISkit by running:" -ForegroundColor Cyan
Write-Host "  & '$ExePath'" -ForegroundColor White
