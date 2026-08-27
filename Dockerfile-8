FROM python:3.11-slim

# WORKDIR을 /app 으로 두면 디렉터리 'app'이 패키지로 먼저 인식되어
# gunicorn의 app:app 이 app.py 를 못 찾는다 (ModuleNotFoundError: No module named 'app').
# 그래서 /srv 를 사용한다.
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# ── 배포 안전장치 ────────────────────────────────────────────────
# 정적 파일이 빌드 컨텍스트에 없으면 여기서 빌드를 즉시 실패시킨다.
# 실패하면 새 이미지가 안 만들어지므로 Cloud Run은 직전 정상 리비전을
# 계속 서빙한다. 파일이 빠진 채로 조용히 배포돼 404가 뜨는 사고를 막는다.
RUN set -e; \
    for f in index.html app.py manifest.json; do \
      [ -f "/srv/$f" ] || { echo "!! 빌드 중단: $f 가 없습니다"; exit 1; }; \
    done; \
    echo "== 정적 파일 확인 =="; \
    ls -l /srv/index.html; \
    echo "index.html bytes: $(wc -c < /srv/index.html)"

ENV PORT=8080
# 백테스트가 오래 걸릴 수 있어 타임아웃 넉넉히(900s). 병렬 스캔이라 스레드 8개.
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 --timeout 900 app:app
