@echo off
REM ============================================================
REM  斗地主 · 防火墙放行（必须“以管理员身份运行”）
REM  作用：允许局域网内其他设备访问本机的 8080 端口。
REM  在 Windows 上直接运行 start-host.bat 前，请先执行本脚本一次。
REM ============================================================
set PORT=8080
powershell -NoProfile -Command "if (-not (Get-NetFirewallRule -DisplayName 'DDZ_Server_8080' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'DDZ_Server_8080' -Direction Inbound -Protocol TCP -LocalPort %PORT% -Action Allow -Profile Private,Public; Write-Host '已添加防火墙放行规则 DDZ_Server_8080' } else { Write-Host '防火墙规则已存在，无需重复添加' }"
echo.
echo 如果上面提示“拒绝访问/需要管理员”，请关闭本窗口，
echo 右键本文件 -> “以管理员身份运行”。
pause
