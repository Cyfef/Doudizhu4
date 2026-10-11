@echo off
REM ============================================================
REM  斗地主 · 在 Windows 上直接运行（普通双击即可，无需管理员）
REM  适用：在 Windows 电脑上直接跑服务，让同局域网手机/平板访问最稳。
REM  前置：请先“以管理员身份运行” allow-firewall.bat 放行一次防火墙。
REM  说明：服务绑定 0.0.0.0，手机/平板用本机“以太网/WLAN”的 IPv4 即可访问。
REM ============================================================
cd /d "%~dp0"
set PORT=8080

REM 优先用系统 node。找不到时给出明确提示，避免旧的本机私有路径失效后静默失败。
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js，或把 node.exe 所在目录加入 PATH。
  echo 下载地址：https://nodejs.org/
  pause
  exit /b 1
)
set NODE=node

echo ============================================================
echo  本机各网卡 IP（手机/平板请连同一网络后用下面某个 IP 访问）：
echo ------------------------------------------------------------
powershell -NoProfile -Command "Get-NetIPConfiguration | Where-Object {$_.InterfaceAlias -notmatch 'Loopback' -and $_.IPv4Address} | ForEach-Object { $_.InterfaceAlias + '  =  ' + ($_.IPv4Address.IPAddress -join ',') }"
echo ------------------------------------------------------------
echo  手机访问示例： http://<上面“以太网/WLAN”的IPv4>:%PORT%
echo  本机访问：     http://localhost:%PORT%
echo  按 Ctrl+C 停止服务。
echo ============================================================
"%NODE%" server/index.js
