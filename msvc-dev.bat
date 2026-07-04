@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "PATH=C:\Users\Peilin\.cargo\bin;%PATH%"
set "http_proxy=http://127.0.0.1:7897"
set "https_proxy=http://127.0.0.1:7897"
set "RUST_BACKTRACE=1"
cd /d "C:\Users\Peilin\Desktop\Github\linco"
call npm run tauri:dev
echo TAURI_DEV_EXIT=%ERRORLEVEL%
