# Start the Pocket Option dashboard detached, unless already running.
# Safe to run repeatedly (idempotent via the port check).
$project = $PSScriptRoot
Set-Location $project

$listening = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    exit 0
}

$pythonw = Join-Path $project "venv\Scripts\pythonw.exe"
if (-not (Test-Path $pythonw)) {
    $pythonw = Join-Path $project "venv\Scripts\python.exe"
}

$outLog = Join-Path $project "logs\server.log"
$errLog = Join-Path $project "logs\server.err.log"
Start-Process -FilePath $pythonw `
    -ArgumentList "app.py" `
    -WorkingDirectory $project `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog
