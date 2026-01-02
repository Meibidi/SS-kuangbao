@echo off
setlocal EnableDelayedExpansion

set /p UUID=请输入标准 UUID（如 55d9ec38-1b8a-454b-981a-6acfe8f56d8c）:

:: 去掉连字符
set HEX=%UUID:-=%

:: 计算长度
set LEN=0
for %%A in (%HEX%) do set LEN=%%~nA
set LEN=%LEN%

:: 更可靠的长度校验
if not "%HEX:~32,1%"=="" (
    echo UUID 长度不正确
    pause
    exit /b
)
if "%HEX:~31,1%"=="" (
    echo UUID 长度不正确
    pause
    exit /b
)

:: 构造 Uint8Array
set RESULT=Uint8Array([
for /L %%i in (0,2,30) do (
    set BYTE=!HEX:~%%i,2!
    if %%i==30 (
        set RESULT=!RESULT!0x!BYTE!
    ) else (
        set RESULT=!RESULT!0x!BYTE!,
    )
)
set RESULT=!RESULT!])

echo.
echo %RESULT%
pause
