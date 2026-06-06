@echo off
setlocal enabledelayedexpansion

echo ========================================
echo KITCHEN FLOW BUILD v2.1.8
echo ========================================
echo.

cd /d D:\kitchen-flow\kitchen_flow\electron-bridge
if errorlevel 1 (
    echo ERRO: Pasta nao encontrada
    pause
    exit /b 1
)

echo [1/8] Fechando processos...
taskkill /F /IM electron.exe 2>nul
taskkill /F /IM "Kitchen Flow Bridge.exe" 2>nul
taskkill /F /IM node.exe 2>nul
timeout /t 2 /nobreak >nul

echo [2/8] Limpando caches...
if exist dist rmdir /s /q dist
if exist node_modules rmdir /s /q node_modules
if exist package-lock.json del /f package-lock.json
call npm cache clean --force

echo [3/8] Instalando dependencias...
call npm install --legacy-peer-deps
if errorlevel 1 (
    echo ERRO: Falha na instalacao
    pause
    exit /b 1
)

echo [4/8] Instalando Electron...
call npm install electron@27.0.0 --save-dev
if errorlevel 1 (
    echo ERRO: Falha ao instalar Electron
    pause
    exit /b 1
)

echo [5/8] Instalando WebSocket...
call npm install ws@8.14.2 --save
if errorlevel 1 (
    echo ERRO: Falha ao instalar ws
    pause
    exit /b 1
)

echo [6/8] Verificando instalacao...
call npm list electron
call npm list ws
timeout /t 3 /nobreak >nul

echo [7/8] Gerando build...
call npm run build
if errorlevel 1 (
    echo.
    echo ERRO: Build completo falhou. Tentando build portatil...
    call npm run build:dir
    if errorlevel 1 (
        echo ERRO CRITICO: Nenhum build funcionou
        pause
        exit /b 1
    )
    echo.
    echo Build portatil gerado com sucesso!
) else (
    echo [8/8] Build completo gerado com sucesso!
)

echo.
echo ========================================
echo BUILD CONCLUIDO!
echo ========================================
echo.
echo Arquivos gerados em: dist\
echo.
dir dist\*.exe 2>nul
dir dist\win-unpacked 2>nul

pause