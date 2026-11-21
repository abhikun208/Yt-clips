param([switch]$StartServer)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Test-Command($Name) { return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue) }
Write-Host "Checking YT-CLIPS updates..." -ForegroundColor Cyan

if (Test-Command git) {
    $isRepository = (& git rev-parse --is-inside-work-tree 2>$null)
    if ($LASTEXITCODE -eq 0 -and $isRepository -eq "true") {
        $remote = (& git remote get-url origin 2>$null)
        if ($LASTEXITCODE -ne 0 -or -not $remote) {
            Write-Host "No Git origin is configured; source updates skipped." -ForegroundColor Yellow
        } else {
            $dirty = (& git status --porcelain)
            if ($dirty) {
                Write-Host "Local changes hain; auto pull skip kiya, files preserve hui." -ForegroundColor Yellow
            } else {
                & git pull --ff-only
                if ($LASTEXITCODE -ne 0) { throw "Git update failed; local files were not reset." }
            }
        }
    } else {
        Write-Host "This is not a Git clone; source updates skipped." -ForegroundColor Yellow
    }
} else {
    Write-Host "Git not found; source updates skipped." -ForegroundColor Yellow
}

& npm.cmd install
if ($LASTEXITCODE -ne 0) { throw "npm dependencies update nahi hui." }
& npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw "Typecheck fail hua; server start nahi hua." }

if ($StartServer) {
    Write-Host "Starting YT-CLIPS..." -ForegroundColor Green
    & npm.cmd start
}
