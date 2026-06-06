@echo off
setlocal enabledelayedexpansion

echo ========================================
echo KITCHEN FLOW DEPLOY v2.1.8
echo ========================================
echo.

call build.bat

if not exist "dist\Kitchen Flow Bridge Setup 2.1.8.exe" (
    if not exist "dist\win-unpacked\Kitchen Flow Bridge.exe" (
        echo ERRO: Build nao foi gerado
        pause
        exit /b 1
    )
)

echo.
echo Copiando para pendrive...
echo.

if not exist "E:\KitchenFlow-v2.1.8" mkdir "E:\KitchenFlow-v2.1.8"

if exist "dist\Kitchen Flow Bridge Setup 2.1.8.exe" (
    copy "dist\Kitchen Flow Bridge Setup 2.1.8.exe" "E:\KitchenFlow-v2.1.8\" /Y
    echo Instalador copiado!
)

if exist "dist\win-unpacked" (
    xcopy /E /I /Y "dist\win-unpacked" "E:\KitchenFlow-v2.1.8\win-unpacked"
    echo Build portatil copiado!
)

copy "..\SEGURANCA_REDE.md" "E:\KitchenFlow-v2.1.8\" /Y
copy "..\CHANGELOG-v2.1.8.md" "E:\KitchenFlow-v2.1.8\" /Y 2>nul

echo.
echo ========================================
echo DEPLOY CONCLUIDO!
echo ========================================
echo.
echo Arquivos em: E:\KitchenFlow-v2.1.8\
echo.
dir "E:\KitchenFlow-v2.1.8\"

pause