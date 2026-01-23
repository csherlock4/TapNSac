@echo off
cd /d "%~dp0backend"
pip install -r requirements.txt
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
pause
