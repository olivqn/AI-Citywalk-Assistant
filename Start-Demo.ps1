param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$demoRoot = $PSScriptRoot
$demoUrl = 'http://127.0.0.1:8000'
Set-Location -LiteralPath $demoRoot

function Get-DemoHealth {
    try { return Invoke-RestMethod -Uri "$demoUrl/api/health" -TimeoutSec 2 } catch { return $null }
}

try {
    $demoHealth = Get-DemoHealth
    if ($demoHealth.app -eq 'xuhui-citywalk') {
        Write-Host "Demo is ready: $demoUrl"
        if (!$NoBrowser) { Start-Process $demoUrl }
        exit 0
    }

    $demoPython = Join-Path $demoRoot '.venv\Scripts\python.exe'
    $existingRuntime = Join-Path $env:TEMP 'dachuangx-demo-venv\Scripts\python.exe'
    if (!(Test-Path -LiteralPath $demoPython) -and (Test-Path -LiteralPath $existingRuntime)) {
        $demoPython = $existingRuntime
    }
    if (!(Test-Path -LiteralPath $demoPython)) {
        python -m venv (Join-Path $demoRoot '.venv')
        if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.11 or later, then try again.' }
    }
    & $demoPython -B -c 'import fastapi, uvicorn, httpx, dotenv'
    if ($LASTEXITCODE -ne 0) {
        & $demoPython -m pip install -r (Join-Path $demoRoot 'requirements.txt')
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your network and try again.' }
    }

    $demoLogs = Join-Path $demoRoot '.demo-logs'
    New-Item -ItemType Directory -Path $demoLogs -Force | Out-Null
    $demoProcess = Start-Process -FilePath $demoPython -ArgumentList '-B -m uvicorn main:app --host 127.0.0.1 --port 8000' -WorkingDirectory $demoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $demoLogs 'server.log') -RedirectStandardError (Join-Path $demoLogs 'server-error.log') -PassThru
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $demoHealth = Get-DemoHealth
        if ($demoHealth.app -eq 'xuhui-citywalk') {
            Write-Host "Demo is ready: $demoUrl"
            if (!$NoBrowser) { Start-Process $demoUrl }
            exit 0
        }
        if ($demoProcess.HasExited) { throw 'Server did not start. See .demo-logs/server-error.log (port 8000 may be in use).' }
        Start-Sleep -Milliseconds 500
    }
    throw 'Server is not ready. See .demo-logs/server-error.log.'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
