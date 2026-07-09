@echo off
chcp 936 >nul
echo ========================================
echo   视频合并工具 - 一键打包
echo ========================================
echo.

set START_TIME=%TIME%
echo 开始时间: %START_TIME%
echo.

call npm run dist
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [失败] 打包出错，请检查上方错误信息
    pause
    exit /b 1
)

echo.
echo ========================================
echo   打包完成！
echo   安装包: dist\video-merger-1.0.0-setup.exe
echo   开始: %START_TIME%  结束: %TIME%
echo ========================================
echo.

explorer dist
pause
