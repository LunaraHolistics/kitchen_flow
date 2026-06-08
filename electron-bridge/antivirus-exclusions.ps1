# Kitchen Flow Bridge - Configuração de Exclusões do Windows Defender
# Executar como Administrador

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Kitchen Flow Bridge - Configurando Antivírus" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Verificar se está rodando como administrador
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "ERRO: Execute como Administrador!" -ForegroundColor Red
    Write-Host "Clique direito no arquivo → 'Executar como Administrador'" -ForegroundColor Yellow
    Pause
    exit 1
}

# Obter pasta de downloads do usuário
$downloadPath = [Environment]::GetFolderPath("UserProfile") + "\Downloads"

Write-Host "Configurando exclusões para: $downloadPath" -ForegroundColor Green
Write-Host ""

# Adicionar exclusão de pasta
try {
    Add-MpPreference -ExclusionPath $downloadPath -ErrorAction Stop
    Write-Host "[OK] Pasta de downloads adicionada às exclusões" -ForegroundColor Green
} catch {
    Write-Host "[ERRO] Falha ao adicionar exclusão de pasta: $_" -ForegroundColor Red
}

# Adicionar exclusão de processo
$bridgePath = $PSScriptRoot
try {
    Add-MpPreference -ExclusionProcess "Kitchen Flow Bridge.exe" -ErrorAction Stop
    Write-Host "[OK] Processo do Bridge adicionado às exclusões" -ForegroundColor Green
} catch {
    Write-Host "[INFO] Processo ainda não instalado (será adicionado após instalação)" -ForegroundColor Yellow
}

# Adicionar exclusão de extensão de arquivo
try {
    Add-MpPreference -ExclusionExtension ".saiposprt" -ErrorAction Stop
    Write-Host "[OK] Extensão .saiposprt adicionada às exclusões" -ForegroundColor Green
} catch {
    Write-Host "[ERRO] Falha ao adicionar exclusão de extensão: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Configuração concluída!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "O Windows Defender não irá mais bloquear:" -ForegroundColor White
Write-Host "  ✓ Pasta: $downloadPath" -ForegroundColor White
Write-Host "  ✓ Extensão: .saiposprt" -ForegroundColor White
Write-Host "  ✓ Processo: Kitchen Flow Bridge.exe" -ForegroundColor White
Write-Host ""
Write-Host "Pressione qualquer tecla para sair..." -ForegroundColor Yellow
Pause
