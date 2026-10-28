@echo off
rem Texture launcher.
rem Uses the py launcher first, so the right interpreter is picked even when
rem several Python versions are installed (only some have tkinter / fastapi).
cd /d "%~dp0"

set "LNCH="
where pyw >nul 2>nul && set "LNCH=pyw"
if not defined LNCH (
    where py >nul 2>nul && set "LNCH=py"
)

if defined LNCH (
    for %%V in (3.15 3.14 3.13 3.12 3.11 3.10 3.9) do (
        %LNCH% -%%V -c "import tkinter" >nul 2>nul
        if not errorlevel 1 (
            start "" %LNCH% -%%V "launcher.py"
            exit /b
        )
    )
    %LNCH% -c "import tkinter" >nul 2>nul
    if not errorlevel 1 (
        start "" %LNCH% "launcher.py"
        exit /b
    )
)

where pythonw >nul 2>nul
if not errorlevel 1 (
    start "" pythonw "launcher.py"
    exit /b
)

python "launcher.py"
if errorlevel 1 (
    echo.
    echo Failed to start. Install dependencies first:
    echo     pip install -r requirements.txt
    pause
)
