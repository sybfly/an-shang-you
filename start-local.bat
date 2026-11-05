@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   暗上游 · 本地预览
echo   打开浏览器访问 http://127.0.0.1:8080
echo   这是静态文件服务，不是游戏服务器。
echo.
where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8080 --bind 127.0.0.1
  goto :eof
)
where py >nul 2>nul
if %errorlevel%==0 (
  py -m http.server 8080 --bind 127.0.0.1
  goto :eof
)
echo 没有找到 Python。也可以运行：node server.mjs
pause
