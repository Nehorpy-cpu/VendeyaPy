# Apaga n8n (Docker). Los emuladores se frenan con Ctrl+C en su ventana.
# Uso:  powershell -ExecutionPolicy Bypass -File 90-ops\dev-down.ps1

docker compose -f "$PSScriptRoot\docker-compose.yml" down
Write-Host "n8n detenido. (Los datos persisten en el volumen aiafg_n8n_data.)" -ForegroundColor Green
