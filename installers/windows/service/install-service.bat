@echo off
REM Register Grove Control as a Windows service via NSSM.
REM
REM Called from Inno Setup's [Run] section. Arguments:
REM   %1 = install dir (e.g. C:\Program Files\Grove Control)
REM   %2 = data dir   (e.g. C:\ProgramData\Grove Control)
REM   %3 = port       (e.g. 8000)
REM
REM If the service already exists (re-install / upgrade), remove and
REM re-create it so config changes from this build apply.

setlocal

set "INSTALL_DIR=%~1"
set "DATA_ROOT=%~2"
set "PORT=%~3"

set "NSSM=%INSTALL_DIR%\bin\nssm.exe"
set "PYTHON=%INSTALL_DIR%\python\python.exe"
set "APP_DIR=%INSTALL_DIR%\app"
set "BIN_DIR=%INSTALL_DIR%\bin"
set "DATA_DIR=%DATA_ROOT%\data"
set "LOG_DIR=%DATA_ROOT%\logs"

REM Stop and remove any previous registration. Errors are non-fatal —
REM "service not found" returns non-zero and we want to proceed.
"%NSSM%" stop "Grove Control" 2>nul
"%NSSM%" remove "Grove Control" confirm 2>nul

REM Register the service. NSSM wraps uvicorn so Windows treats it as a
REM proper service (autostart, recovery, supervised restart).
"%NSSM%" install "Grove Control" "%PYTHON%" "-m uvicorn backend.app.main:app --host 0.0.0.0 --port %PORT%"
if errorlevel 1 (
    echo [install-service] nssm install failed
    exit /b 1
)

REM Service configuration
"%NSSM%" set "Grove Control" AppDirectory "%APP_DIR%"
"%NSSM%" set "Grove Control" DisplayName "Grove Control"
"%NSSM%" set "Grove Control" Description "Grove Control — local-first Bambu Lab printer manager"
"%NSSM%" set "Grove Control" Start SERVICE_AUTO_START

REM Environment: point DATA_DIR + LOG_DIR at ProgramData, prepend our
REM bin/ to PATH so ffmpeg/ffprobe are found by the shutil.which() lookup
REM in backend/app/services/layer_timelapse.py.
"%NSSM%" set "Grove Control" AppEnvironmentExtra ^
    "DATA_DIR=%DATA_DIR%" ^
    "LOG_DIR=%LOG_DIR%" ^
    "PORT=%PORT%" ^
    "PATH=%BIN_DIR%;%PATH%"

REM Stdout / stderr capture. Rotate at 10MB.
"%NSSM%" set "Grove Control" AppStdout "%LOG_DIR%\service-stdout.log"
"%NSSM%" set "Grove Control" AppStderr "%LOG_DIR%\service-stderr.log"
"%NSSM%" set "Grove Control" AppRotateFiles 1
"%NSSM%" set "Grove Control" AppRotateOnline 1
"%NSSM%" set "Grove Control" AppRotateBytes 10485760

REM Run as LocalSystem (default). Required for binding 322/990/8883 if
REM the user later enables the Virtual Printer feature. Most non-VP
REM workloads would work as a less-privileged account, but service
REM identity changes are disruptive — pick the broader one once.

REM Start the service. If it fails to start, NSSM exits non-zero and
REM Inno Setup will surface this to the user.
"%NSSM%" start "Grove Control"
if errorlevel 1 (
    echo [install-service] nssm start failed — check %LOG_DIR%\service-stderr.log
    exit /b 1
)

echo [install-service] Grove Control service registered and started on port %PORT%
endlocal
exit /b 0
