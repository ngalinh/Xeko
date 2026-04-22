@echo off
title Xeko Local Server
:loop
echo [%date% %time%] Dang khoi dong Xeko Local Server...
node local-server.js
echo [%date% %time%] Server da dung. Khoi dong lai sau 2 giay...
timeout /t 2 /nobreak >nul
goto loop
