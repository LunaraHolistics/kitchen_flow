@echo off
setlocal enabledelayedexpansion

echo ========================================
echo KITCHEN FLOW - UPDATE + BUILD v2.1.9
echo ========================================
echo.

:: 1. Navegar para a pasta do projeto
cd /d D:\kitchen-flow\kitchen_flow
if errorlevel 1 (
    echo ERRO: Pasta nao encontrada
    pause
    exit /b 1
)

:: 2. Git pull
echo [1/8] Atualizando do GitHub...
git pull origin main
if errorlevel 1 (
    echo AVISO: Falha ao puxar do GitHub. Continuando com arquivos locais...
)

:: 3. Navegar para electron-bridge
cd electron-bridge

:: 4. Limpar caches
echo [2/8] Limpando caches...
if exist dist rmdir /s /q dist
if exist node_modules rmdir /s /q node_modules
if exist package-lock.json del /f package-lock.json
call npm cache clean --force

:: 5. Instalar dependências
echo [3/8] Instalando dependencias...
call npm install --legacy-peer-deps
call npm install electron@27.0.0 --save-dev
call npm install ws@8.14.2 --save

:: 6. Verificar instalação
echo [4/8] Verificando instalacao...
call npm list electron | findstr "electron"
call npm list ws | findstr "ws"

:: 7. Gerar builds
echo [5/8] Gerando build COMPLETO (instalador)...
call npm run build
set BUILD_SUCCESS=!errorlevel!

if !BUILD_SUCCESS! neq 0 (
    echo.
    echo AVISO: Build completo falhou. Tentando build PORTATIL...
    call npm run build:dir
    if errorlevel 1 (
        echo ERRO CRITICO: Nenhum build funcionou
        pause
        exit /b 1
    )
    echo ✅ Build PORTATIL gerado com sucesso!
) else (
    echo ✅ Build COMPLETO gerado com sucesso!
)

:: 8. Copiar para pendrive
echo [6/8] Copiando para pendrive...
if not exist E:\KitchenFlow-v2.1.9 mkdir E:\KitchenFlow-v2.1.9

if exist "dist\Kitchen Flow Bridge Setup 2.1.9.exe" (
    copy "dist\Kitchen Flow Bridge Setup 2.1.9.exe" "E:\KitchenFlow-v2.1.9\" /Y
    echo ✅ Instalador copiado!
)

if exist dist\win-unpacked (
    xcopy /E /I /Y dist\win-unpacked E:\KitchenFlow-v2.1.9\win-unpacked
    echo ✅ Build portatil copiado!
)

copy ..\SEGURANCA_REDE.md E:\KitchenFlow-v2.1.9\ /Y
copy ..\CHANGELOG-v2.1.9.md E:\KitchenFlow-v2.1.9\ /Y 2>nul

:: 9. Confirmar
echo [7/8] Concluido!
echo.
echo ========================================
echo BUILD FINAL CONCLUIDO!
echo ========================================
echo.
echo Arquivos em: E:\KitchenFlow-v2.1.9\
dir E:\KitchenFlow-v2.1.9\

:: 10. Ejetar pendrive (opcional - requer permissões)
:: echo [8/8] Ejetando pendrive...
:: powershell "(New-Object -ComObject Shell.Application).Namespace(17).ParseName('E:').InvokeVerb('Eject')" 2>nul

pause