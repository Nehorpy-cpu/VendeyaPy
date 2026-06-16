# Levanta el entorno de desarrollo local de AI_AFG:
#   1) n8n en Docker
#   2) Emuladores de Firebase (Firestore + Functions) — en primer plano
#
# Uso:  powershell -ExecutionPolicy Bypass -File 90-ops\dev-up.ps1
# Para apagar n8n después:  90-ops\dev-down.ps1   (Ctrl+C frena los emuladores)

$ErrorActionPreference = 'Stop'
$ops  = $PSScriptRoot
$root = Split-Path $ops -Parent   # C:\AI_AFG

Write-Host "==> Levantando n8n (Docker)..." -ForegroundColor Cyan
docker compose -f "$ops\docker-compose.yml" up -d
Write-Host "    n8n: http://localhost:5678" -ForegroundColor Green

# Java para el emulador de Firestore (toma el JDK de Microsoft si no está en PATH)
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
  $jdk = Get-ChildItem "C:\Program Files\Microsoft\" -Directory -Filter "jdk*" -ErrorAction SilentlyContinue | Select-Object -Last 1
  if ($jdk) { $env:JAVA_HOME = $jdk.FullName; $env:PATH = "$($jdk.FullName)\bin;$env:PATH" }
  else { Write-Warning "Java no encontrado. Instalá con: winget install Microsoft.OpenJDK.21" }
}

Write-Host "==> Levantando emuladores de Firebase (Ctrl+C para frenar)..." -ForegroundColor Cyan
Write-Host "    Firestore UI: http://localhost:4000   |   Functions: http://localhost:5001" -ForegroundColor Green
Set-Location "$root\10-backend"
pnpm exec firebase emulators:start --only "firestore,functions" --project demo-aiafg
