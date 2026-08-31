# -*- coding: utf-8 -*-
"""
TMT 자산관리 / 보유세 API 서버 (Cloud Run)
==============================================================
- 종목검색·현재가·환율·배당이력 (FinanceDataReader / yfinance)
- 부동산 보유세 탭 (도로명주소·공시가격 프록시)
- 정적 파일 서빙: index.html(자산관리 셸) + 아이콘 + manifest.json

v0829.001 변경 (현재가가 하루 밀리던 문제 수정)
  - /prices: yf.download에 period="10d" 대신 명시적 start/end 사용.
             period를 쓰면 yfinance가 종료 시점을 '오늘 00:00'으로 잡아
             직전 거래일 바가 범위 밖으로 잘려 나가, 늘 하루 늦은 종가가 나왔다.
             end를 오늘+2일로 열어두면 최신 종가가 정상 포함된다.
  - /prices: auto_adjust=True → False. 배당 조정이 들어가면 증권사 화면의
             종가와 미세하게 어긋난다. 현재가 표시에는 원본 종가가 맞다.
  - _price_one: yfinance 폴백을 history(period="1mo", auto_adjust=False)로.
                FDR 조회 구간도 15일 → 30일 (긴 연휴 방어).

(이전 이력)
v0818.001 : /price NaN 버그 수정, /prices 일괄 조회 신설, _last_valid_close 헬퍼
v0807.005 : /backtest·/diag 등 자동매매·백테스트 라우트 제거, strategy.py import 제거
v0807.004 : /search 폴백 조건 수정(정확 티커 일치 없으면 yfinance 확인) + _US_EXTRA에 BLOX 보강
v0806.001 : 보유세 탭 (/addr, /gongsiga, /gongsiga_raw)
v0803.011 : 정적 파일 서빙 추가 (index.html + 아이콘 + manifest.json)
"""

import os
import time
import math
import pickle
import threading
import traceback
from datetime import datetime

from flask import Flask, request, jsonify, send_from_directory, abort
from flask_cors import CORS

# 배포 버전 (코드 바꿀 때마다 여기 숫자를 올린다. 화면·응답에 찍혀서 배포 확인용)
BACKEND_VERSION = "v0829.001"

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False
CORS(app)

# 검색 종목 리스트 디스크 캐시 등에 사용 (/tmp는 인스턴스 재시작 시 초기화됨)
CACHE_DIR = "/tmp/ohlcv_cache"
os.makedirs(CACHE_DIR, exist_ok=True)


def _err(step, e, code=500, extra=None):
    """일관된 에러 응답. step으로 어느 단계에서 죽었는지 표시."""
    payload = {
        "error": str(e),
        "step": step,
        "type": e.__class__.__name__ if isinstance(e, BaseException) else "str",
        "trace": traceback.format_exc(),
    }
    if extra:
        payload.update(extra)
    return jsonify(payload), code


def _retry(fn, tries=3, delay=0.7):
    """FDR/외부 API 호출은 서버 사정으로 간헐 실패 -> 짧게 재시도. 마지막 예외는 올림."""
    last = None
    for i in range(tries):
        try:
            return fn()
        except Exception as e:  # noqa
            last = e
            time.sleep(delay * (i + 1))
    if last:
        raise last
    return None


def _last_valid_close(df):
    """OHLCV DataFrame에서 '마지막 유효(NaN 아님) 종가'와 그 날짜를 반환. 없으면 (None, None).

    FDR/yfinance가 최근 행 Close를 NaN으로 주는 경우가 잦아(장 미마감·피드 지연·상장폐지 등),
    맨 끝 행을 그대로 집으면 NaN이 나온다 → dropna 후 마지막 값을 쓴다.
    """
    try:
        if df is None or len(df) == 0:
            return None, None
        if "Close" in getattr(df, "columns", []):
            s = df["Close"]
        else:
            # 단일 컬럼 프레임 등 → 마지막 컬럼 사용
            s = df.iloc[:, -1]
        s = s.dropna()
        if s is None or len(s) == 0:
            return None, None
        val = float(s.iloc[-1])
        if not math.isfinite(val):
            return None, None
        return val, str(s.index[-1])[:10]
    except Exception:
        return None, None


# ---------------------------------------------------------------------
# 라우트
# ---------------------------------------------------------------------
@app.route("/")
def root():
    """앱 화면(index.html)을 서빙. 같은 폴더의 index.html을 그대로 내보낸다."""
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(here, "index.html")
        with open(path, "r", encoding="utf-8") as f:
            html = f.read()
        return html, 200, {"Content-Type": "text/html; charset=utf-8"}
    except Exception as e:
        # index.html이 없으면 상태 JSON으로 폴백
        return jsonify({"service": "tmt-asset", "status": "ok",
                        "version": BACKEND_VERSION, "note": f"index.html 없음: {e}",
                        "time": datetime.now().isoformat()})


@app.route("/status")
def status():
    """상태·버전 확인용 JSON. 환경변수 설정 여부도 함께 노출(값은 가림)."""
    def mask(v):
        if not v:
            return None
        return (v[:4] + "..." + v[-4:]) if len(v) > 10 else "설정됨"
    return jsonify({"service": "tmt-asset", "status": "ok",
                    "version": BACKEND_VERSION,
                    "gongsiga_mode": "vworld-ned",   # NED 속성조회 방식인지 확인용
                    "env": {"VWORLD_KEY": mask(VWORLD_KEY), "BLD_KEY": mask(BLD_KEY),
                            "VWORLD_DOMAIN": os.environ.get("VWORLD_DOMAIN") or None},
                    "time": datetime.now().isoformat()})


@app.route("/health")
def health():
    return jsonify({"status": "healthy"})


# ---------------------------------------------------------------------
# 종목 검색 / 환율 (자산관리 앱용) — FinanceDataReader 사용
#   - /search?q=리&market=all|us|kr  -> 종목 자동완성
#   - /fxrate?date=YYYYMMDD          -> 그날(또는 직전영업일) USD/KRW 종가
# ---------------------------------------------------------------------
_SEARCH_CACHE = {"rows": None}          # [{ticker,name,market,currency}]
_SEARCH_LOCK = threading.Lock()
_SEARCH_DISK = os.path.join(CACHE_DIR, "search_rows_v3.pkl")   # v3: 국내 ETF 포함

def _warmup_search():
    """서버 시작 직후 백그라운드로 종목 리스트를 미리 로딩 → 첫 검색이 빨라짐."""
    try:
        _load_search_rows()
    except Exception:
        pass

# 미국 주식 한글 별칭 (해외주식은 FDR에 영문명만 있어 한글 검색이 안 되므로 인기 종목만 매핑)
_US_ALIAS = {
    "리얼티인컴": "O", "리얼티": "O", "코카콜라": "KO", "코카": "KO", "펩시": "PEP",
    "알트리아": "MO", "존슨앤존슨": "JNJ", "피앤지": "PG", "프록터앤갬블": "PG",
    "버라이즌": "VZ", "at&t": "T", "에이티앤티": "T", "쓰리엠": "MMM", "3m": "MMM",
    "엑슨": "XOM", "엑슨모빌": "XOM", "셰브론": "CVX", "쉐브론": "CVX",
    "메인스트리트": "MAIN", "메인": "MAIN", "애그넥": "AGNC", "슈드": "SCHD",
    "제피": "JEPI", "제피큐": "JEPQ", "디비디": "DGRO", "브이와이엠": "VYM",
    "애플": "AAPL", "마이크로소프트": "MSFT", "엔비디아": "NVDA", "테슬라": "TSLA",
    "리비안": "RIVN", "아이비엠": "IBM", "화이자": "PFE", "맥도날드": "MCD",
    "스타벅스": "SBUX", "월마트": "WMT", "홈디포": "HD", "맥쿼리": "MQ",
    "브로드컴": "AVGO", "애브비": "ABBV", "필립모리스": "PM",
    "블럭스": "BLOX", "블록스": "BLOX", "니콜라스크립토": "BLOX",
    "펩시코": "PEP", "소노코": "SON", "호멜": "HRL", "킴벌리클라크": "KMB",
}

# 국내 ETF 한글 검색 보조: 'kodex'를 '코덱스'로도 찾게 한다 (반대도 동일)
_KR_BRAND = {"코덱스": "kodex", "타이거": "tiger", "에이스": "ace",
             "쏠": "sol", "솔": "sol", "플러스": "plus", "히어로즈": "heroes",
             "아리랑": "arirang", "킨덱스": "kindex", "코세프": "kosef"}

# 상장리스트(FDR)에서 자주 누락되는 인기 배당 ETF/종목 보강 (즉시·안정 검색)
_US_EXTRA = [
    ("JEPI", "JPMorgan Equity Premium Income ETF"),
    ("JEPQ", "JPMorgan Nasdaq Equity Premium Income ETF"),
    ("SCHD", "Schwab US Dividend Equity ETF"),
    ("SCHY", "Schwab International Dividend Equity ETF"),
    ("VYM", "Vanguard High Dividend Yield ETF"),
    ("DGRO", "iShares Core Dividend Growth ETF"),
    ("HDV", "iShares Core High Dividend ETF"),
    ("DVY", "iShares Select Dividend ETF"),
    ("NOBL", "ProShares S&P 500 Dividend Aristocrats ETF"),
    ("SPYD", "SPDR Portfolio S&P 500 High Dividend ETF"),
    ("SPHD", "Invesco S&P 500 High Dividend Low Volatility ETF"),
    ("QYLD", "Global X NASDAQ 100 Covered Call ETF"),
    ("XYLD", "Global X S&P 500 Covered Call ETF"),
    ("RYLD", "Global X Russell 2000 Covered Call ETF"),
    ("DIVO", "Amplify CWP Enhanced Dividend Income ETF"),
    ("JPST", "JPMorgan Ultra-Short Income ETF"),
    ("O", "Realty Income Corp"),
    ("MAIN", "Main Street Capital Corp"),
    ("AGNC", "AGNC Investment Corp"),
    ("STAG", "Stag Industrial Inc"),
    ("QQQ", "Invesco QQQ Trust"),
    ("SPY", "SPDR S&P 500 ETF Trust"),
    ("VOO", "Vanguard S&P 500 ETF"),
    ("VTI", "Vanguard Total Stock Market ETF"),
    ("SCHG", "Schwab US Large-Cap Growth ETF"),
    ("VIG", "Vanguard Dividend Appreciation ETF"),
    # 신규 상장 ETF는 FDR 리스팅에 늦게 반영됨 → 수동 보강
    ("BLOX", "Nicholas Crypto Income ETF"),
]


def _has_hangul(s):
    return any("\uac00" <= ch <= "\ud7a3" for ch in (s or ""))


def _load_search_rows():
    """FDR 리스팅을 한 번만 로드해 메모리 캐시. (KR + US)"""
    if _SEARCH_CACHE["rows"] is not None:
        return _SEARCH_CACHE["rows"]
    with _SEARCH_LOCK:
        if _SEARCH_CACHE["rows"] is not None:
            return _SEARCH_CACHE["rows"]
        # 디스크 캐시: 같은 인스턴스에서 24시간 내 재사용 시 즉시 로드(네트워크 생략)
        try:
            if os.path.exists(_SEARCH_DISK) and (time.time() - os.path.getmtime(_SEARCH_DISK) < 86400):
                with open(_SEARCH_DISK, "rb") as f:
                    cached = pickle.load(f)
                if cached:
                    _SEARCH_CACHE["rows"] = cached
                    return cached
        except Exception:
            pass
        import FinanceDataReader as fdr
        rows = []

        def add(df, market, currency, code_cols, name_cols):
            if df is None or len(df) == 0:
                return
            cc = next((c for c in code_cols if c in df.columns), None)
            nc = next((c for c in name_cols if c in df.columns), None)
            if cc is None or nc is None:
                return
            for _, r in df.iterrows():
                code = str(r[cc]).strip()
                name = str(r[nc]).strip()
                if not code or not name or name == "nan":
                    continue
                rows.append({"ticker": code, "name": name, "market": market, "currency": currency})

        # 한국 (KRX = KOSPI+KOSDAQ, 한글명 포함)
        try:
            kr = _retry(lambda: fdr.StockListing("KRX"), tries=2, delay=0.6)
            add(kr, "KRX", "KRW",
                ["Code", "code", "Symbol", "종목코드"],
                ["Name", "name", "종목명"])
        except Exception:
            pass
        # 국내 ETF — KRX 리스팅에는 개별 주식만 있어 ETF가 통째로 빠진다.
        # KODEX·TIGER·SOL 같은 월배당·커버드콜 ETF를 검색하려면 이게 필요하다.
        try:
            etf = _retry(lambda: fdr.StockListing("ETF/KR"), tries=2, delay=0.6)
            add(etf, "KRX", "KRW",
                ["Symbol", "symbol", "Code", "code", "종목코드"],
                ["Name", "name", "종목명"])
        except Exception:
            pass
        # 미국 (영문명)
        for mk in ("NASDAQ", "NYSE", "AMEX"):
            try:
                us = _retry(lambda mk=mk: fdr.StockListing(mk), tries=2, delay=0.6)
                add(us, mk, "USD",
                    ["Symbol", "symbol", "Code", "code"],
                    ["Name", "name"])
            except Exception:
                pass

        # 인기 ETF/종목 보강 (상장리스트에 없으면 추가)
        have = {r["ticker"].upper() for r in rows}
        for tk, nm in _US_EXTRA:
            if tk.upper() not in have:
                rows.append({"ticker": tk, "name": nm, "market": "US", "currency": "USD"})
                have.add(tk.upper())

        try:
            with open(_SEARCH_DISK, "wb") as f:
                pickle.dump(rows, f)
        except Exception:
            pass
        _SEARCH_CACHE["rows"] = rows
        return rows


@app.route("/search")
def search():
    q = (request.args.get("q") or "").strip()
    market = (request.args.get("market") or "all").lower()
    if len(q) < 1:
        return jsonify([])
    try:
        rows = _load_search_rows()
    except Exception as e:
        return _err("search_load", e)

    ql = q.lower()
    for _k, _v in _KR_BRAND.items():  # '코덱스200' → 'kodex200'
        if _k in ql:
            ql = ql.replace(_k, _v)
    qs = ql.replace(" ", "")          # 공백 제거본: 'kodex200' ↔ 'KODEX 200타겟...'
    hangul = _has_hangul(q)

    # 미국 종목 한글 별칭 -> 티커 매칭 (질의가 한글일 때)
    alias_tickers = set()
    if hangul:
        for k, tk in _US_ALIAS.items():
            if ql in k.lower():
                alias_tickers.add(tk.upper())

    scored = []
    for r in rows:
        if market == "us" and r["currency"] != "USD":
            continue
        if market == "kr" and r["currency"] != "KRW":
            continue
        tk = r["ticker"].lower()
        nm = r["name"].lower()
        nms = nm.replace(" ", "")
        score = None
        if r["ticker"].upper() in alias_tickers:
            score = 0                      # 한글 별칭 정확 매칭 최우선
        elif tk == ql:
            score = 1
        elif tk.startswith(ql):
            score = 2
        elif nms.startswith(qs):
            score = 3
        elif (not hangul and ql in tk):
            score = 4
        elif qs in nms:                    # 공백 무시 부분일치
            score = 5
        if score is not None:
            scored.append((score, len(r["name"]), r))

    scored.sort(key=lambda x: (x[0], x[1]))
    out = [r for _, _, r in scored[:20]]

    # 폴백: 질의가 '티커 형태'인데 결과에 '정확한 티커 일치'가 없으면 yfinance로 실종목 확인.
    #  - 예) "blox" 검색 시 이름 부분일치로 Roblox(RBLX)만 뜨고, 정작 BLOX(신규 ETF)는
    #    FDR 상장리스트에 없어 안 잡히던 문제 해결. 실티커를 찾으면 맨 앞에 끼워 넣는다.
    #  - 기존엔 'not out'(결과 완전 공백)일 때만 폴백했던 탓에, 엉뚱한 이름 부분일치가
    #    결과를 채우면 폴백이 아예 안 돌았다.
    import re as _re
    has_exact = any(r["ticker"].lower() == ql for r in out)
    if not hangul and not has_exact and _re.match(r"^[A-Za-z.\-]{1,6}$", q):
        try:
            import yfinance as yf
            sym = q.upper()
            info = {}
            try:
                info = yf.Ticker(sym).get_info()
            except Exception:
                info = getattr(yf.Ticker(sym), "info", {}) or {}
            nm = info.get("shortName") or info.get("longName")
            # ETF/주식 등 실제 상장 종목만(펀드형·환율 등 오탐 방지: quoteType 참고)
            qt = (info.get("quoteType") or "").upper()
            if nm and qt in ("ETF", "EQUITY", "MUTUALFUND", "INDEX", "", None):
                hit = {"ticker": sym, "name": nm,
                       "market": info.get("exchange") or "US", "currency": "USD"}
                # 같은 티커가 이미 있으면 제거하고 맨 앞에 배치
                out = [hit] + [r for r in out if r["ticker"].upper() != sym][:19]
        except Exception:
            pass

    return jsonify(out)


@app.route("/fxrate")
def fxrate():
    """USD/KRW 종가. date 미지정 시 최근. 해당일 없으면 직전 영업일."""
    from datetime import datetime as _dt, timedelta
    raw = (request.args.get("date") or "").replace("-", "").strip()
    try:
        if raw:
            d = _dt.strptime(raw, "%Y%m%d")
        else:
            d = _dt.now()
    except Exception:
        return jsonify({"error": "date 형식은 YYYYMMDD"}), 400
    try:
        import FinanceDataReader as fdr
        start = (d - timedelta(days=10)).strftime("%Y-%m-%d")
        end = d.strftime("%Y-%m-%d")
        df = _retry(lambda: fdr.DataReader("USD/KRW", start, end), tries=2, delay=0.5)
        rate, used = _last_valid_close(df)   # NaN 방어
        if rate is None:
            return jsonify({"error": "환율 데이터 없음", "date": end}), 404
        return jsonify({"date": used, "rate": round(rate, 2)})
    except Exception as e:
        return _err("fxrate", e)


# ---------------------------------------------------------------------
# 워밍업 / 현재가 / 배당이력 (자산관리 앱용)
# ---------------------------------------------------------------------
@app.route("/warm")
def warm():
    """앱이 열릴 때 호출 → 백그라운드로 종목 리스트 미리 로딩(서버 깨우기). 즉시 응답."""
    ready = _SEARCH_CACHE["rows"] is not None
    if not ready:
        try: threading.Thread(target=_warmup_search, daemon=True).start()
        except Exception: pass
    return jsonify({"warming": True, "ready": ready, "version": BACKEND_VERSION})


def _yf_symbol(ticker, market):
    m = (market or "").upper()
    if m in ("KOSPI", "KRX", "KOSDAQ", "KONEX", ""):
        # 국내: .KS(코스피)·.KQ(코스닥) 둘 다 후보로 두고 되는 걸 사용
        if m == "KOSDAQ":
            return [ticker + ".KQ", ticker + ".KS"]
        return [ticker + ".KS", ticker + ".KQ"]
    return [ticker]  # 미국 등 해외


def _is_kr(market):
    return (market or "").upper() in ("KOSPI", "KRX", "KOSDAQ", "KONEX", "")


def _price_one(ticker, market):
    """단일 종목 현재가. (price, date, source) 반환. 실패 시 (None, None, None).

    국내는 FDR(종목코드) 우선, 해외는 yfinance 우선 — 각 소스가 강한 쪽을 먼저.
    어느 쪽이든 NaN이면 다음 소스로 넘어간다.
    """
    from datetime import datetime as _dt, timedelta
    # 긴 연휴에는 15일로도 유효 종가가 안 잡히는 경우가 있어 30일로 넓힌다
    start = (_dt.now() - timedelta(days=30)).strftime("%Y-%m-%d")

    def try_fdr():
        try:
            import FinanceDataReader as fdr
            df = _retry(lambda: fdr.DataReader(ticker, start), tries=1, delay=0.3)
            v, dt = _last_valid_close(df)
            if v is not None:
                return v, dt, "fdr"
        except Exception:
            pass
        return None

    def try_yf():
        try:
            import yfinance as yf
            for sym in _yf_symbol(ticker, market):
                try:
                    # auto_adjust=False: 배당 조정이 들어가면 증권사 화면 종가와 어긋난다
                    h = yf.Ticker(sym).history(period="1mo", auto_adjust=False)
                    v, dt = _last_valid_close(h)
                    if v is not None:
                        return v, dt, "yfinance:" + sym
                except Exception:
                    pass
        except Exception:
            pass
        return None

    order = (try_fdr, try_yf) if _is_kr(market) else (try_yf, try_fdr)
    for fn in order:
        r = fn()
        if r:
            return r
    return None, None, None


@app.route("/price")
def price():
    """현재가(최근 유효 종가). ?ticker=O&market=NYSE (미국) / ?ticker=005930&market=KRX (국내)

    핵심: 최근일 종가가 NaN이어도 dropna로 '마지막 유효 종가'를 쓰고, 그래도 없으면
    다른 소스로 폴백. 끝내 없으면 price:null(NaN을 JSON에 싣지 않음)."""
    ticker = (request.args.get("ticker") or "").strip()
    market = (request.args.get("market") or "").strip()
    if not ticker:
        return jsonify({"error": "ticker 필요"}), 400
    v, dt, src = _price_one(ticker, market)
    if v is not None:
        return jsonify({"ticker": ticker, "price": round(v, 4), "date": dt, "source": src})
    # 실패: NaN을 싣지 않고 null 반환 (앱이 파싱 실패 없이 '현재가 없음'으로 처리)
    return jsonify({"ticker": ticker, "price": None, "error": "현재가 조회 실패"}), 200


@app.route("/prices")
def prices():
    """여러 종목 현재가 '한 번에' 조회. 종목 100개+ 대응.

    요청 형식(둘 중 하나):
      /prices?items=ARR:NYSE,BLOX:US,005930:KRX     (ticker:market 쌍을 콤마로)
      /prices?tickers=ARR,BLOX&markets=NYSE,US       (markets 생략 가능)
    반환: {"prices": {"ARR": {"price":..,"date":..,"source":..}, ...}, "count": n}

    구현: 해외는 yfinance batch download(한 번의 네트워크로 다량 조회) → 못 받은 것만 단건 폴백.
          국내(.KS/.KQ)도 batch에 함께 넣고, 누락분은 FDR 단건으로 보완.
    """
    items_raw = (request.args.get("items") or "").strip()
    pairs = []
    if items_raw:
        for tok in items_raw.split(","):
            tok = tok.strip()
            if not tok:
                continue
            if ":" in tok:
                t, m = tok.split(":", 1)
            else:
                t, m = tok, ""
            t = t.strip()
            if t:
                pairs.append((t, m.strip()))
    else:
        tks = [t.strip() for t in (request.args.get("tickers") or "").split(",") if t.strip()]
        mks = [m.strip() for m in (request.args.get("markets") or "").split(",")]
        for i, t in enumerate(tks):
            pairs.append((t, mks[i] if i < len(mks) else ""))

    # 중복 티커 제거(입력 순서 유지)
    seen = set()
    uniq = []
    for t, m in pairs:
        if t not in seen:
            seen.add(t)
            uniq.append((t, m))
    pairs = uniq
    if not pairs:
        return jsonify({"prices": {}, "count": 0})

    out = {}

    # 1) yfinance 일괄 다운로드 --------------------------------------------------
    sym_map = {}          # ticker -> [yahoo 심볼 후보]
    all_syms = []
    for t, m in pairs:
        syms = _yf_symbol(t, m)
        sym_map[t] = syms
        for s in syms:
            if s not in all_syms:
                all_syms.append(s)

    data = None
    if all_syms:
        try:
            import yfinance as yf
            from datetime import datetime as _dt2, timedelta as _td2
            # period="10d"를 쓰면 yfinance가 종료 시점을 '오늘 00:00'으로 잡아
            # 직전 거래일 바가 잘려 나간다 → end를 오늘+2일로 열어 최신 종가를 포함시킨다.
            _start = (_dt2.now() - _td2(days=20)).strftime("%Y-%m-%d")
            _end = (_dt2.now() + _td2(days=2)).strftime("%Y-%m-%d")
            data = yf.download(all_syms, start=_start, end=_end, group_by="ticker",
                               threads=True, progress=False, auto_adjust=False)
        except Exception:
            data = None

    def close_from_batch(sym):
        if data is None:
            return None, None
        try:
            if len(all_syms) == 1:
                sub = data
            else:
                # group_by='ticker' → 상위 레벨이 심볼. 없으면 KeyError.
                sub = data[sym]
            col = sub["Close"] if "Close" in getattr(sub, "columns", []) else None
            if col is None:
                return None, None
            s = col.dropna()
            if len(s) == 0:
                return None, None
            v = float(s.iloc[-1])
            if not math.isfinite(v):
                return None, None
            return v, str(s.index[-1])[:10]
        except Exception:
            return None, None

    missing = []
    for t, m in pairs:
        hit = None
        for sym in sym_map[t]:
            v, dt = close_from_batch(sym)
            if v is not None:
                out[t] = {"price": round(v, 4), "date": dt, "source": "yfinance:" + sym}
                hit = True
                break
        if not hit:
            missing.append((t, m))

    # 2) 누락분 단건 폴백(FDR/yfinance) -----------------------------------------
    for t, m in missing:
        v, dt, src = _price_one(t, m)
        if v is not None:
            out[t] = {"price": round(v, 4), "date": dt, "source": src}

    return jsonify({"prices": out, "count": len(out), "requested": len(pairs)})


@app.route("/dividends")
def dividends():
    """공개 배당이력(주당배당금). ?ticker=O&market=NYSE&years=3
       반환: [{date:'YYYY-MM-DD', perShare: float}]  (오래된→최근)
       yfinance 필요(없으면 안내). 실입금액과 다를 수 있어 앱에서 수정.
       날짜는 지급일이 아니라 '배당락일'이다. 앱이 지급월로 옮겨 담는다."""
    ticker = (request.args.get("ticker") or "").strip()
    market = (request.args.get("market") or "").strip()
    try:
        years = int(request.args.get("years") or 3)
    except Exception:
        years = 3
    if not ticker:
        return jsonify({"error": "ticker 필요"}), 400
    try:
        import yfinance as yf
    except Exception:
        return jsonify({"error": "yfinance 미설치", "hint": "requirements.txt에 yfinance 추가 후 재배포"}), 501
    from datetime import datetime as _dt
    cutoff = _dt.now().year - years
    for sym in _yf_symbol(ticker, market):
        try:
            s = yf.Ticker(sym).dividends
            if s is None or len(s) == 0:
                continue
            out = []
            for idx, val in s.items():
                try:
                    y = idx.year
                    if y < cutoff:
                        continue
                    fv = float(val)
                    if not math.isfinite(fv):
                        continue
                    out.append({"date": str(idx)[:10], "perShare": round(fv, 6)})
                except Exception:
                    continue
            if out:
                out.sort(key=lambda x: x["date"])
                return jsonify({"ticker": ticker, "symbol": sym, "count": len(out), "dividends": out})
        except Exception:
            continue
    return jsonify({"ticker": ticker, "count": 0, "dividends": []})


# ---------------------------------------------------------------------
# 부동산 보유세 탭 (v0806.001)
#   - /addr        : 행안부 도로명주소 검색API 프록시
#   - /gongsiga    : 국토부 공동주택가격정보 프록시
#   - /gongsiga_raw: 응답 필드명 확인용(확인 뒤 지워도 됨)
#
#   환경변수 (Cloud Run > 변수 및 보안 비밀):
#     JUSO_KEY    business.juso.go.kr → API신청하기 → 도로명주소 검색API
#     VWORLD_KEY  data.go.kr 15124003 (공동주택가격정보) 인증키
#   ⚠ 리포가 Public이므로 키는 코드에 직접 넣지 말 것.
# ---------------------------------------------------------------------
JUSO_KEY = os.environ.get("JUSO_KEY", "")
VWORLD_KEY = os.environ.get("VWORLD_KEY", "")
BLD_KEY = os.environ.get("BLD_KEY", "")   # 건축물대장(주택가격) 서비스키


def _http_text(url, params, timeout=20, tries=3):
    """
    응답 '원문'을 그대로 반환. (status, text)
    VWorld는 간헐적으로 연결을 끊으므로 재시도 + User-Agent 지정.
    """
    import time as _time
    import urllib.parse
    import urllib.request

    q = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
    full = f"{url}?{q}"
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; TMT/1.0)",
        "Accept": "application/json, text/xml;q=0.9, */*;q=0.8",
        "Connection": "close",          # keep-alive 로 끊기는 문제 회피
    }
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(full, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read().decode("utf-8", errors="replace")
                return r.status, body
        except Exception as e:
            last = e
            _time.sleep(0.6 * (i + 1))
    raise last


def _http_json(url, params, timeout=12):
    """requests 없이도 동작하도록 urllib 폴백. (FDR이 requests를 끌고 오지만 방어)"""
    try:
        import requests
        r = requests.get(url, params=params, timeout=timeout)
        return r.json()
    except ImportError:
        import json as _json
        import urllib.parse
        import urllib.request
        q = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        req = urllib.request.Request(f"{url}?{q}", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return _json.loads(resp.read().decode("utf-8"))


@app.route("/addr")
def addr_search():
    """
    주소 검색. GET /addr?keyword=반포동 18-1
    응답: {results:[{roadAddr, jibunAddr, bdNm, admCd, lnbrMnnm, lnbrSlno, mtYn, bdKdncd}]}
    admCd(법정동코드 10자리) + mtYn(산여부) + 본번/부번 → 프런트에서 PNU 19자리 조립
    """
    keyword = (request.args.get("keyword") or "").strip()
    if not keyword:
        return jsonify({"error": "keyword 필요"}), 400
    if not JUSO_KEY:
        return jsonify({"error": "JUSO_KEY 미설정",
                        "hint": "Cloud Run 환경변수에 JUSO_KEY 추가 후 재배포"}), 500

    # 도로명+건물번호가 붙어 있으면 띄어쓰기 보정 ("반포대로333" -> "반포대로 333")
    # juso API는 붙여 쓰면 엉뚱한 결과를 주는 경우가 있다.
    import re as _re
    kw = _re.sub(r"([가-힣])(\d)", r"\1 \2", keyword)
    kw = _re.sub(r"\s+", " ", kw).strip()

    try:
        j = _http_json(
            "https://business.juso.go.kr/addrlink/addrLinkApi.do",
            {"confmKey": JUSO_KEY, "currentPage": 1, "countPerPage": 20,
             "keyword": kw, "resultType": "json"},
        )
        common = (j.get("results") or {}).get("common") or {}
        if common.get("errorCode") != "0":
            return jsonify({"error": common.get("errorMessage", "주소 API 오류"),
                            "code": common.get("errorCode")}), 502
        out = [{
            "roadAddr":  a.get("roadAddr"),
            "jibunAddr": a.get("jibunAddr"),
            "bdNm":      a.get("bdNm"),
            "admCd":     a.get("admCd"),
            "lnbrMnnm":  a.get("lnbrMnnm"),
            "lnbrSlno":  a.get("lnbrSlno"),
            "mtYn":      a.get("mtYn"),
            "bdKdncd":   a.get("bdKdncd"),
            "zipNo":     a.get("zipNo"),
        } for a in ((j.get("results") or {}).get("juso") or [])]
        return jsonify({"results": out, "count": len(out)})
    except Exception as e:
        return _err("addr_search", e)


def _digits(s):
    return "".join(ch for ch in str(s or "") if ch.isdigit())


@app.route("/gongsiga")
def gongsiga():
    """
    공시가격 조회 — VWorld NED '공동주택가격 속성조회'
      GET /gongsiga?pnu=1165010700100180001&year=2026&dong=105&ho=303
      응답: {year, price, matched:{...}, count}   price 단위 = 원

    NED 계열 엔드포인트 규격:
      https://api.vworld.kr/ned/data/getApartHousingPriceAttr
        ?key=&domain=&pnu=&stdrYear=&format=json&numOfRows=&pageNo=
    """
    pnu = request.args.get("pnu")
    year = request.args.get("year") or str(datetime.now().year)
    dong = request.args.get("dong") or ""
    ho = request.args.get("ho") or ""
    if not pnu:
        return jsonify({"error": "pnu 필요"}), 400
    if not VWORLD_KEY:
        return jsonify({"error": "VWORLD_KEY 미설정",
                        "hint": "Cloud Run 환경변수에 VWORLD_KEY 추가 후 재배포"}), 500

    try:
        errors = []
        rows, used = [], ""
        # 1순위: 건축물대장 주택가격(호별) → 2순위: VWorld 공동주택가격
        for fn in (lambda: _bld_house_price(pnu, dong, ho),
                   lambda: _ned_apart_price(pnu, year)):
            try:
                rows, used = fn()
                if rows:
                    break
            except Exception as e:
                errors.append(f"{e.__class__.__name__}: {e}")
        if not rows:
            return jsonify({"year": year, "price": 0,
                            "note": "조회 결과 없음", "errors": errors})

        cand = rows
        if dong:
            f1 = [r for r in cand if _digits(_pick(r, "dong")) == _digits(dong)]
            if f1:
                cand = f1
        if ho:
            f2 = [r for r in cand if _digits(_pick(r, "ho")) == _digits(ho)]
            if f2:
                cand = f2

        # 해당 연도 데이터 우선
        yr = [r for r in cand if str(year) in " ".join(str(v) for v in r.values())]
        if yr:
            cand = yr

        r0 = cand[0]
        price = _digits(_pick(r0, "price"))
        return jsonify({
            "year": year,
            "price": int(price) if price else 0,
            "matched": {"dong": _pick(r0, "dong"), "ho": _pick(r0, "ho"),
                        "area": _pick(r0, "area")},
            "count": len(cand), "total": len(rows), "source": used,
        })
    except Exception as e:
        return _err("gongsiga", e)


# NED 응답에서 값 꺼내기 (필드명이 버전마다 달라 유연하게 매칭)
_FIELD_HINTS = {
    "dong":  ("dongnm", "dong", "bldngnm"),
    "ho":    ("honm", "ho", "hosunm"),
    "price": ("hsprc", "pblntfpc", "pc", "price", "prc", "amt", "gongsi"),
    "area":  ("privarea", "area", "sqm", "flrarea"),
}


def _pick(row, kind):
    """행(dict)에서 kind에 해당하는 값을 찾아 반환."""
    hints = _FIELD_HINTS[kind]
    for k, v in row.items():
        kl = str(k).lower()
        for h in hints:
            if h in kl:
                if kind == "price" and not _digits(v):
                    continue
                return v
    return ""


def _vworld_domain():
    """VWorld는 domain 파라미터를 요구한다. 미설정 시 현재 서비스 호스트를 사용."""
    d = os.environ.get("VWORLD_DOMAIN", "").strip()
    if d:
        return d
    try:
        host = request.host_url  # https://xxx.run.app/
        return host.replace("https://", "").replace("http://", "").rstrip("/")
    except Exception:
        return ""


def _ned_apart_price(pnu, year):
    """
    VWorld NED 공동주택가격 속성조회.
    format=json 우선, 실패 시 xml. domain 파라미터 필수.
    반환: (행 리스트, 사용한 엔드포인트)
    """
    import json as _json

    names = ["getApartHousingPriceAttr", "getApartHousingPrice"]
    last = None
    for name in names:
        for fmt in ("xml", "json"):
            try:
                status, body = _http_text(
                    f"https://api.vworld.kr/ned/data/{name}",
                    {"key": VWORLD_KEY,
                     "domain": _vworld_domain(),
                     "pnu": pnu, "stdrYear": str(year),
                     "format": fmt, "numOfRows": 100, "pageNo": 1})
            except Exception as e:
                last = e
                continue
            if not body or not body.strip():
                continue
            rows = []
            if fmt == "json":
                try:
                    rows = _extract_rows(_json.loads(body))
                except Exception:
                    rows = []
            if not rows:
                rows = _rows_from_xml(body)
            if rows:
                return rows, f"vworld:{name}:{fmt}"
    if last:
        raise last
    return [], names[0]


def _bld_house_price(pnu, dong, ho):
    """
    국토교통부 건축물대장 '주택가격(공시가격)' 조회.
      https://apis.data.go.kr/1613000/BldRgstHubService/getBrHsprcInfo
    PNU 19자리에서 파라미터를 분해해 호출한다.
      법정동코드10 = 시군구코드5 + 법정동코드5
      산여부(11번째): 1=대지 -> platGbCd 0, 2=산 -> platGbCd 1
      본번4 + 부번4
    반환: (행 리스트, 태그)
    """
    import json as _json

    if not BLD_KEY or not pnu or len(pnu) < 19:
        return [], "bld:skip"

    sigungu, bjdong = pnu[:5], pnu[5:10]
    plat_gb = "1" if pnu[10] == "2" else "0"
    bun, ji = pnu[11:15], pnu[15:19]

    params = {
        "serviceKey": BLD_KEY,
        "sigunguCd": sigungu, "bjdongCd": bjdong, "platGbCd": plat_gb,
        "bun": bun, "ji": ji,
        "numOfRows": 500, "pageNo": 1, "_type": "json",
    }
    if dong:
        params["dongNm"] = dong
    if ho:
        params["hoNm"] = ho

    status, body = _http_text(
        "https://apis.data.go.kr/1613000/BldRgstHubService/getBrHsprcInfo",
        params, timeout=20)
    rows = []
    try:
        rows = _extract_rows(_json.loads(body))
    except Exception:
        rows = _rows_from_xml(body)
    return rows, "bld:getBrHsprcInfo"


def _rows_from_xml(text):
    """XML 응답을 dict 리스트로. (필드명은 그대로 유지)"""
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(text)
    except Exception:
        return []
    rows = []
    for parent in root.iter():
        kids = list(parent)
        if not kids:
            continue
        # 자식이 모두 말단(텍스트) 노드인 요소 = 한 행
        if all(len(k) == 0 for k in kids) and len(kids) >= 3:
            row = {k.tag: (k.text or "").strip() for k in kids}
            if any(v for v in row.values()):
                rows.append(row)
    return rows


def _extract_rows(obj):
    """NED 응답 구조가 제각각이라, dict 리스트를 재귀로 찾아낸다."""
    found = []

    def walk(o):
        if isinstance(o, list):
            if o and all(isinstance(x, dict) for x in o):
                found.append(o)
            else:
                for x in o:
                    walk(x)
        elif isinstance(o, dict):
            for v in o.values():
                walk(v)

    walk(obj)
    if not found:
        return []
    # 가격으로 보이는 필드를 가진 리스트를 우선 선택
    for lst in found:
        if _pick(lst[0], "price"):
            return lst
    return max(found, key=len)


@app.route("/gongsiga_raw")
def gongsiga_raw():
    """원본 응답 확인용. 파싱하지 않고 서버가 준 텍스트를 그대로 보여준다."""
    pnu = request.args.get("pnu")
    year = request.args.get("year") or str(datetime.now().year)
    if not pnu:
        return jsonify({"error": "pnu 필요"}), 400
    if not VWORLD_KEY:
        return jsonify({"error": "VWORLD_KEY 미설정"}), 500

    out = {"pnu": pnu, "year": year, "domain": _vworld_domain(),
           "bld_key": bool(BLD_KEY), "tried": {}}

    # 건축물대장 주택가격
    if BLD_KEY:
        try:
            sigungu, bjdong = pnu[:5], pnu[5:10]
            plat_gb = "1" if pnu[10] == "2" else "0"
            st, body = _http_text(
                "https://apis.data.go.kr/1613000/BldRgstHubService/getBrHsprcInfo",
                {"serviceKey": BLD_KEY, "sigunguCd": sigungu, "bjdongCd": bjdong,
                 "platGbCd": plat_gb, "bun": pnu[11:15], "ji": pnu[15:19],
                 "numOfRows": 20, "pageNo": 1, "_type": "json"}, timeout=20)
            out["tried"]["bld:getBrHsprcInfo"] = {"status": st, "len": len(body),
                                                  "body": body[:1200]}
        except Exception as e:
            out["tried"]["bld:getBrHsprcInfo"] = {"error": f"{e.__class__.__name__}: {e}"}
    else:
        out["tried"]["bld:getBrHsprcInfo"] = {"skip": "BLD_KEY 미설정"}

    # VWorld
    for name in ("getApartHousingPriceAttr",):
        for fmt in ("xml", "json"):
            tag = f"vworld:{name}:{fmt}"
            try:
                st, body = _http_text(
                    f"https://api.vworld.kr/ned/data/{name}",
                    {"key": VWORLD_KEY, "domain": _vworld_domain(),
                     "pnu": pnu, "stdrYear": str(year),
                     "format": fmt, "numOfRows": 20, "pageNo": 1})
                out["tried"][tag] = {"status": st, "len": len(body), "body": body[:1200]}
            except Exception as e:
                out["tried"][tag] = {"error": f"{e.__class__.__name__}: {e}"}
    return jsonify(out)


# ---------------------------------------------------------------------
# 정적 파일 서빙 (자산관리 셸 · 아이콘 · manifest)
#   - "/"는 위에서 index.html을 직접 서빙
#   - 아래 라우트는 나머지 정적파일만 처리 (icon-*.png, manifest.json, sw.js 등)
#   - 명시 라우트(/status, /search, /price, /prices, /fxrate 등)가 우선 매칭되므로 충돌 없음
#   - 화이트리스트 확장자만 허용 -> app.py 등 소스는 노출되지 않음
# ---------------------------------------------------------------------
STATIC_OK = {".html", ".png", ".json", ".ico", ".webmanifest", ".svg", ".css", ".js"}


@app.route("/<path:fname>")
def static_files(fname):
    ext = os.path.splitext(fname)[1].lower()
    if ext in STATIC_OK:
        here = os.path.dirname(os.path.abspath(__file__))
        if os.path.exists(os.path.join(here, fname)):
            return send_from_directory(here, fname)
    abort(404)


# 앱 부팅 시 웜업 스레드 1회 실행 (gunicorn 워커가 뜰 때 각 1회 · 첫 검색 지연 제거)
try:
    threading.Thread(target=_warmup_search, daemon=True).start()
except Exception:
    pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
