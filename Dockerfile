FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8080
# 백테스트가 오래 걸릴 수 있어 타임아웃 넉넉히(900s). 병렬 스캔이라 스레드 8개.
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 --timeout 900 app:app
