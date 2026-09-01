# One-time setup script
$ErrorActionPreference = "Stop"
python -m venv venv
& ".\venv\Scripts\Activate.ps1"
python -m pip install --upgrade pip
pip install -r requirements.txt
Write-Host "Setup complete. Run .\run.ps1 to start the dashboard." -ForegroundColor Green
