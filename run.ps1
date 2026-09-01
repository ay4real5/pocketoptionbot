# PowerShell starter for the Pocket Option signal dashboard
$ErrorActionPreference = "Stop"
$venv = Join-Path $PSScriptRoot "venv\Scripts\Activate.ps1"
if (Test-Path $venv) {
    & $venv
} else {
    Write-Host "Virtual environment not found. Run setup first." -ForegroundColor Red
    exit 1
}
python app.py
