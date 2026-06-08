Write-Host "========================================" -ForegroundColor Cyan
Write-Host "KITCHEN FLOW BUILD FIX v2.1.9" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 1. Limpar caches
Write-Host "[1/8] Limpando caches..." -ForegroundColor Yellow
if (Test-Path dist) { Remove-Item -Recurse -Force dist }
if (Test-Path node_modules) { Remove-Item -Recurse -Force node_modules }
if (Test-Path package-lock.json) { Remove-Item package-lock.json }
npm cache clean --force

# 2. Parar processos em execução
Write-Host "[2/8] Parando processos..." -ForegroundColor Yellow
Get-Process -Name "node","electron" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 3. Instalar com ignore-scripts
Write-Host "[3/8] Instalando dependencias (ignore-scripts)..." -ForegroundColor Yellow
npm install --legacy-peer-deps --ignore-scripts
npm install electron@27.0.0 --save-dev --ignore-scripts
npm install ws@8.14.2 --save --ignore-scripts

# 4. Verificar instalação
Write-Host "[4/8] Verificando instalacao..." -ForegroundColor Yellow
$electron = npm list electron 2>$null
$ws = npm list ws 2>$null

if ($electron -match "electron@27.0.0") {
    Write-Host "✅ Electron instalado!" -ForegroundColor Green
} else {
    Write-Host "❌ Electron NÃO instalado!" -ForegroundColor Red
    exit 1
}

if ($ws -match "ws@8.14.2") {
    Write-Host "✅ WebSocket instalado!" -ForegroundColor Green
} else {
    Write-Host "❌ WebSocket NÃO instalado!" -ForegroundColor Red
    exit 1
}

# 5. Gerar build
Write-Host "[5/8] Gerando build..." -ForegroundColor Yellow
npm run build

# 6. Verificar build
Write-Host "[6/8] Verificando build..." -ForegroundColor Yellow
if (Test-Path "dist\Kitchen Flow Bridge Setup 2.1.9.exe") {
    Write-Host "✅ Build completo gerado!" -ForegroundColor Green
} elseif (Test-Path "dist\win-unpacked\Kitchen Flow Bridge.exe") {
    Write-Host "✅ Build portatil gerado!" -ForegroundColor Green
} else {
    Write-Host "⚠️ Nenhum build encontrado. Tentando build portatil..." -ForegroundColor Yellow
    npm run build:dir
}

# 7. Copiar para pendrive
Write-Host "[7/8] Copiando para pendrive..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path "E:\KitchenFlow-v2.1.9" | Out-Null

if (Test-Path "dist\Kitchen Flow Bridge Setup 2.1.9.exe") {
    Copy-Item "dist\Kitchen Flow Bridge Setup 2.1.9.exe" -Destination "E:\KitchenFlow-v2.1.9\" -Force
}
if (Test-Path "dist\win-unpacked") {
    Copy-Item -Recurse -Force "dist\win-unpacked" -Destination "E:\KitchenFlow-v2.1.9\win-unpacked"
}
Copy-Item "..\SEGURANCA_REDE.md" -Destination "E:\KitchenFlow-v2.1.9\" -Force

# 8. Confirmar
Write-Host "[8/8] Concluido!" -ForegroundColor Green
Write-Host ""
Write-Host "Arquivos em: E:\KitchenFlow-v2.1.9\" -ForegroundColor White
Get-ChildItem "E:\KitchenFlow-v2.1.9\"

Write-Host ""
Write-Host "Pressione qualquer tecla para sair..." -ForegroundColor Yellow
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")