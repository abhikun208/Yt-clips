$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "YT-CLIPS Windows setup" -ForegroundColor Cyan

function Refresh-Path {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
    $wingetLinks = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
    if (Test-Path $wingetLinks) { $env:Path = "$env:Path;$wingetLinks" }
}

function Ensure-WinGetPackage([string]$Id) {
    $listing = (& winget list --id $Id --exact --accept-source-agreements 2>&1 | Out-String)
    if ($LASTEXITCODE -eq 0 -and $listing -match [regex]::Escape($Id)) {
        Write-Host "$Id is already installed." -ForegroundColor DarkGray
        return
    }

    Write-Host "Installing $Id..." -ForegroundColor Yellow
    & winget install --id $Id --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "WinGet could not install $Id (exit $LASTEXITCODE)." }
    Refresh-Path
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "WinGet nahi mila. Microsoft Store se App Installer install karo, phir setup dobara chalao."
}

Ensure-WinGetPackage "Git.Git"
Ensure-WinGetPackage "Gyan.FFmpeg"
Ensure-WinGetPackage "Python.Python.3.12"
Refresh-Path

$node = Get-Command node -ErrorAction SilentlyContinue
$nodeVersion = if ($node) { & $node.Source -p "process.versions.node" } else { "0.0.0" }
if ([version]($nodeVersion -replace '-.*$', '') -lt [version]"22.18.0") {
    Ensure-WinGetPackage "OpenJS.NodeJS.LTS"
    Refresh-Path
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "Node.js install hua lekin current PATH mein nahi mila. Naya terminal kholo aur setup dobara chalao." }
    $nodeVersion = & $node.Source -p "process.versions.node"
}
if ([version]($nodeVersion -replace '-.*$', '') -lt [version]"22.18.0") {
    throw "Node.js $nodeVersion mila. Node.js 22.18 ya naya chahiye."
}

$pythonExe = $null
$pythonPrefix = @()
$launcher = Get-Command py -ErrorAction SilentlyContinue
if ($launcher) {
    & $launcher.Source -3.12 -c "import sys; print(sys.version)" *> $null
    if ($LASTEXITCODE -eq 0) {
        $pythonExe = $launcher.Source
        $pythonPrefix = @("-3.12")
    }
}
if (-not $pythonExe) {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        & $python.Source -c "import sys; print(sys.version)" *> $null
        if ($LASTEXITCODE -eq 0) { $pythonExe = $python.Source }
    }
}
if (-not $pythonExe) { throw "Python 3.12 install hua lekin interpreter nahi mila. Naya terminal kholo aur setup dobara chalao." }

Write-Host "Installing Python helpers and fast local speech-to-text..." -ForegroundColor Yellow
$pipArgs = @($pythonPrefix) + @("-m", "pip", "--isolated", "install", "--ignore-installed", "--upgrade", "yt-dlp", "edge-tts", "av>=18,<19", "faster-whisper", "opencv-python-headless", "numpy")
& $pythonExe @pipArgs
if ($LASTEXITCODE -ne 0) { throw "Python dependencies install nahi hui (pip exit $LASTEXITCODE)." }

$importArgs = @($pythonPrefix) + @("-I", "-c", "import av, faster_whisper, cv2, numpy; assert int(av.__version__.split('.')[0]) == 18")
& $pythonExe @importArgs
if ($LASTEXITCODE -ne 0) { throw "Python packages normal install hue, lekin isolated Python import fail hua." }

$scriptsArgs = @($pythonPrefix) + @("-c", "import sysconfig; print(sysconfig.get_path('scripts'))")
$pythonScripts = (& $pythonExe @scriptsArgs | Select-Object -Last 1).Trim()
if (Test-Path $pythonScripts) {
    $pathEntries = @($env:Path -split ";" | Where-Object { $_ })
    if ($pathEntries -notcontains $pythonScripts) { $env:Path = "$env:Path;$pythonScripts" }
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (@($userPath -split ";" | Where-Object { $_ }) -notcontains $pythonScripts) {
        [Environment]::SetEnvironmentVariable("Path", (($userPath.TrimEnd(";") + ";" + $pythonScripts).TrimStart(";")), "User")
    }
}

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
$ffprobe = Get-Command ffprobe -ErrorAction SilentlyContinue
if (-not $ffmpeg -or -not $ffprobe) { throw "FFmpeg/FFprobe install hua lekin PATH mein nahi mila. Naya terminal kholo aur setup dobara chalao." }

& npm.cmd install
if ($LASTEXITCODE -ne 0) { throw "npm dependencies install nahi hui." }

@("data","assets","assets/music","assets/hooks","assets/gameplay","assets/sfx","assets/vfx_overlays","assets/fonts") | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ | Out-Null }
}

if (-not (Test-Path ".env")) {
    $bytes = New-Object byte[] 24
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    @(
        "YT_CLIPS_TOKEN=$token",
        "HOST=127.0.0.1",
        "PORT=8080",
        "AUTO_RUN=1",
        "AUTO_INSTALL=0"
    ) | Set-Content -Path ".env" -Encoding ascii
    Write-Host "Created .env with a private login token (not displayed)." -ForegroundColor DarkGray
}

& npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw "Typecheck fail hua." }

Write-Host "Setup complete. Start the local dashboard with: npm start" -ForegroundColor Green
