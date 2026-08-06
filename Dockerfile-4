FROM python:3.11-slim

# WORKDIR을 /app 으로 두면 디렉터리 'app'이 패키지로 먼저 인식되어
# gunicorn의 app:app 이 app.py 를 못 찾는다 (ModuleNotFoundError: No module named 'app').
# 그래서 /srv 를 사용한다.
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8080
# 백테스트가 오래 걸릴 수 있어 타임아웃 넉넉히(900s). 병렬 스캔이라 스레드 8개.
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 --timeout 900 app:app
