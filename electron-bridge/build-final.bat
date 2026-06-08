@echo off
echo ========================================
echo KITCHEN FLOW BUILD FINAL v2.1.9
echo ========================================
echo.

cd /d D:\kitchen-flow\kitchen_flow\electron-bridge

echo [1/7] Limpando caches...
if exist dist rmdir /s /q dist
if exist node_modules rmdir /s /q node_modules
if exist package-lock.json del /f package-lock.json
call npm cache clean --force

echo [2/7] Instalando dependencias...
call npm install --legacy-peer-deps
call npm install electron@27.0.0 --save-dev
call npm install ws@8.14.2 --save

echo [3/7] Verificando instalacao...
call npm list electron
call npm list ws

echo [4/7] Gerando build...
call npm run build
if errorlevel 1 (
    echo.
    echo AVISO: Build completo falhou. Tentando build portatil...
    call npm run build:dir
)

echo [5/7] Copiando para pendrive...
if not exist E:\KitchenFlow-v2.1.9 mkdir E:\KitchenFlow-v2.1.9
if exist dist\Kitchen Flow Bridge Setup 2.1.9.exe (
    copy "dist\Kitchen Flow Bridge Setup 2.1.9.exe" "E:\KitchenFlow-v2.1.9\" /Y
)
if exist dist\win-unpacked (
    xcopy /E /I /Y dist\win-unpacked E:\KitchenFlow-v2.1.9\win-unpacked
)
copy ..\SEGURANCA_REDE.md E:\KitchenFlow-v2.1.9\ /Y

echo [6/7] Concluido!
echo.
echo ========================================
echo BUILD FINAL CONCLUIDO!
echo ========================================
echo.
echo Arquivos em: E:\KitchenFlow-v2.1.9\
dir E:\KitchenFlow-v2.1.9\

pause
