FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY strategy.py app.py ./

ENV PORT=8080
# 백테스트가 오래 걸릴 수 있어 타임아웃을 넉넉히(600s), 워커 1개
CMD exec gunicorn --bind :$PORT --workers 1 --threads 4 --timeout 600 app:app
