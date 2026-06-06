@echo off
setlocal enabledelayedexpansion

echo ========================================
echo KITCHEN FLOW BUILD PORTATIL v2.1.8
echo ========================================
echo.

cd /d D:\kitchen-flow\kitchen_flow\electron-bridge
if errorlevel 1 (
    echo ERRO: Pasta nao encontrada
    pause
    exit /b 1
)

echo [1/5] Limpando build anterior...
if exist dist rmdir /s /q dist

echo [2/5] Instalando dependencias...
call npm install --legacy-peer-deps
if errorlevel 1 (
    echo ERRO: Falha na instalacao
    pause
    exit /b 1
)

echo [3/5] Instalando Electron e WebSocket...
call npm install electron@27.0.0 ws@8.14.2 --save-dev
if errorlevel 1 (
    echo ERRO: Falha ao instalar dependencias
    pause
    exit /b 1
)

echo [4/5] Gerando build portatil...
call npm run build:dir
if errorlevel 1 (
    echo ERRO: Build portatil falhou
    pause
    exit /b 1
)

echo [5/5] Build concluido!
echo.
echo Pasta gerada em: dist\win-unpacked\
echo.
dir dist\win-unpacked\Kitchen*.exe 2>nul

pause