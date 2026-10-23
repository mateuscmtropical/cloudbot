<#
.SYNOPSIS
Installs CloudBot on Windows, inside WSL 2.

.DESCRIPTION
CloudBot runs on Linux, so on Windows it runs in an Ubuntu distro of WSL 2. This script checks for WSL, installs
the distro when it is missing, turns on systemd, and runs docker/install.sh inside the distro with the localhost
domain. It works on Windows x64 and on Windows on ARM. WSL picks the matching Ubuntu build.

Run it in PowerShell. Installing WSL needs an administrator session and can ask for a restart. Run the script
again after the restart.

.PARAMETER OwnerName
Name of the first person, the owner. Lowercase letters, numbers and inner hyphens.

.PARAMETER Distro
Name of the WSL distro to install into.

.PARAMETER InstallScriptUrl
Where install.sh comes from. It must be an https address.

.PARAMETER InstallScriptPath
A local install.sh to run instead of downloading one.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\install.ps1 -OwnerName maria
#>
[CmdletBinding()]
param(
    [string]$OwnerName = 'owner',
    [string]$Distro = 'Ubuntu',
    [string]$InstallScriptUrl = 'https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.sh',
    [string]$InstallScriptPath = ''
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)

    Write-Host "==> $Message"
}

function Exit-Install {
    param([string]$Message)

    throw $Message
}

function Test-ValidOwnerName {
    param([string]$Name)

    return $Name.Length -le 63 -and $Name -cmatch '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
}

function Test-ValidDistroName {
    param([string]$Name)

    return $Name -match '^[A-Za-z0-9][A-Za-z0-9._-]*$'
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)

    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# wsl.exe prints UTF-16. PowerShell shows it with a null byte between the letters unless they are removed.
function Get-WslDistroList {
    $lines = & wsl.exe --list --quiet 2>$null
    $cleaned = $lines | ForEach-Object { ($_ -replace "`0", '').Trim() }

    return @($cleaned | Where-Object { $_ -ne '' })
}

function Invoke-InDistro {
    param([string]$Command)

    # Out-Host keeps the output on the screen and out of the value this function returns.
    & wsl.exe -d $Distro -u root -- bash -c $Command | Out-Host

    return $LASTEXITCODE
}

function Install-Distro {
    if (-not (Test-IsAdministrator)) {
        Exit-Install "The $Distro distro is not installed. Open PowerShell as administrator and run this script again."
    }

    Write-Step "installing $Distro with WSL (a restart of Windows may be needed)"
    & wsl.exe --install -d $Distro --no-launch

    if ($LASTEXITCODE -ne 0) {
        Exit-Install 'WSL could not install the distro. Restart Windows if it asked for it, then run this script again.'
    }

    $installed = Get-WslDistroList

    if ($installed -notcontains $Distro) {
        Exit-Install 'Restart Windows, then run this script again to finish the install.'
    }
}

# Docker in the distro runs as a systemd service, so systemd has to be on.
function Enable-Systemd {
    $check = "grep -qs '^systemd=true' /etc/wsl.conf"
    $checkExit = Invoke-InDistro $check

    if ($checkExit -eq 0) {
        Write-Step 'systemd is already on'

        return
    }

    Write-Step 'turning on systemd in the distro'
    $write = "printf '[boot]\nsystemd=true\n' >> /etc/wsl.conf"
    $exitCode = Invoke-InDistro $write

    if ($exitCode -ne 0) {
        Exit-Install 'Could not write /etc/wsl.conf in the distro.'
    }

    & wsl.exe --terminate $Distro
    Start-Sleep -Seconds 3
}

function Get-InstallCommand {
    $arguments = "localhost $OwnerName"

    if ($InstallScriptPath -ne '') {
        $resolved = (Resolve-Path -LiteralPath $InstallScriptPath).Path
        # wsl.exe drops backslashes, so wslpath gets forward slashes.
        $forwardPath = $resolved.Replace('\', '/')
        $linuxPath = (& wsl.exe -d $Distro -u root -- wslpath -a $forwardPath | Out-String).Trim()

        return "bash '$linuxPath' $arguments"
    }

    return "curl -fsSL '$InstallScriptUrl' | bash -s -- $arguments"
}

if (-not (Test-ValidOwnerName $OwnerName)) {
    Exit-Install "Invalid owner name '$OwnerName'. Use lowercase letters, numbers and inner hyphens, up to 63 characters."
}

if (-not (Test-ValidDistroName $Distro)) {
    Exit-Install "Invalid distro name '$Distro'."
}

if ($InstallScriptPath -eq '' -and $InstallScriptUrl -notmatch '^https://[A-Za-z0-9._~:/?#@!$&()*+=%-]+$') {
    Exit-Install 'The install script address must be an https address.'
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Exit-Install 'WSL is not available. Open PowerShell as administrator, run: wsl --install, restart Windows and run this script again.'
}

$distros = Get-WslDistroList

if ($distros -notcontains $Distro) {
    Install-Distro
}

Enable-Systemd

Write-Step 'running the CloudBot installer in the distro (the first build takes a few minutes)'
$installCommand = Get-InstallCommand
$installExit = Invoke-InDistro $installCommand

if ($installExit -ne 0) {
    Exit-Install 'The CloudBot installer failed. See the messages above.'
}

Write-Host ''
Write-Host "Open the owner address above in your Windows browser. It is http://$OwnerName.localhost"
Write-Host "CloudBot runs while WSL runs. To check it: wsl -d $Distro -u root -- cloudbot status"
