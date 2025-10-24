@echo off
REM UUID解码工具 - 单个版本
REM 文件必须保存为UTF-8编码

chcp 65001 >nul
setlocal enabledelayedexpansion

title UUID解码工具
color 0A

echo.
echo ========================================
echo           UUID解码工具 v1.0
echo ========================================
echo.

:INPUT_UUID
echo 请输入UUID（支持带连字符或不带连字符）：
echo 示例：91cb2002-6d55-48ed-a9d9-65bdfb1b93a5
echo.
set /p uuid=请输入: 

if "%uuid%"=="" (
    echo.
    echo 错误：输入不能为空！
    goto INPUT_UUID
)

echo.
echo ========================================
echo 正在解码UUID...
echo ========================================
echo.

call :DECODE_UUID "%uuid%"

echo.
echo ========================================
set /p continue=是否继续解码其他UUID？(Y/N): 
if /i "!continue!"=="Y" (
    echo.
    goto INPUT_UUID
)

echo.
echo 感谢使用UUID解码工具！
timeout /t 2 >nul
exit /b 0

:: ========================================
:: UUID解码主函数
:: ========================================
:DECODE_UUID
set "uuid=%~1"
set "original_uuid=%~1"

echo 原始UUID: %original_uuid%

:: 移除连字符和空格
set "clean_uuid=%uuid:-=%"
set "clean_uuid=%clean_uuid: =%"

:: 验证长度
if not "!clean_uuid:~32!"=="" (
    echo 错误：UUID长度无效！应为32个十六进制字符。
    goto :EOF
)

if "!clean_uuid:~0,32!"=="" (
    echo 错误：UUID不能为空！
    goto :EOF
)

:: 验证十六进制字符
set "hex_chars=0123456789abcdefABCDEF"
set "valid=1"
for /l %%i in (0,1,31) do (
    set "char=!clean_uuid:~%%i,1!"
    if "!hex_chars:%char%=!"=="!hex_chars!" (
        echo 错误：包含无效的十六进制字符 '!char!'！
        set "valid=0"
        goto :VALIDATION_DONE
    )
)
:VALIDATION_DONE

if !valid!==0 goto :EOF

:: 转换为大写以便统一处理
set "clean_uuid=!clean_uuid:a=A!"
set "clean_uuid=!clean_uuid:b=B!"
set "clean_uuid=!clean_uuid:c=C!"
set "clean_uuid=!clean_uuid:d=D!"
set "clean_uuid=!clean_uuid:e=E!"
set "clean_uuid=!clean_uuid:f=F!"

:: 开始解码
set "result="
set "byte_count=0"

:: 按顺序处理每个字节（2个十六进制字符）
for /l %%i in (0,2,30) do (
    set "hex_byte=!clean_uuid:~%%i,2!"
    call :HEX_TO_DEC "!hex_byte!"
    
    set "result=!result!!dec_value!"
    set /a byte_count+=1
    
    if !byte_count! lss 16 (
        set "result=!result!,"
    )
)

:: 显示结果
echo.
echo 解码成功！
echo.
echo 十进制格式：
echo [!result!]
echo.
echo 十六进制格式：
call :SHOW_HEX_FORMAT "!clean_uuid!"
echo.
echo 字节数组格式：
echo bytes([!result!])
goto :EOF

:: ========================================
:: 显示十六进制格式
:: ========================================
:SHOW_HEX_FORMAT
set "hex_result="
set "clean_uuid=%~1"

for /l %%i in (0,2,30) do (
    set "hex_byte=!clean_uuid:~%%i,2!"
    set "hex_result=!hex_result!0x!hex_byte!"
    if %%i lss 30 (
        set "hex_result=!hex_result!, "
    )
)
echo [!hex_result!]
goto :EOF

:: ========================================
:: 十六进制转十进制函数
:: ========================================
:HEX_TO_DEC
set "hex=%~1"
set "dec_value=0"

for /l %%i in (0,1,1) do (
    set "digit=!hex:~%%i,1!"
    
    if "!digit!"=="0" set /a "value=0"
    if "!digit!"=="1" set /a "value=1"
    if "!digit!"=="2" set /a "value=2"
    if "!digit!"=="3" set /a "value=3"
    if "!digit!"=="4" set /a "value=4"
    if "!digit!"=="5" set /a "value=5"
    if "!digit!"=="6" set /a "value=6"
    if "!digit!"=="7" set /a "value=7"
    if "!digit!"=="8" set /a "value=8"
    if "!digit!"=="9" set /a "value=9"
    if "!digit!"=="A" set /a "value=10"
    if "!digit!"=="B" set /a "value=11"
    if "!digit!"=="C" set /a "value=12"
    if "!digit!"=="D" set /a "value=13"
    if "!digit!"=="E" set /a "value=14"
    if "!digit!"=="F" set /a "value=15"
    
    if %%i==0 (
        set /a "dec_value=value*16"
    ) else (
        set /a "dec_value+=value"
    )
)
goto :EOF