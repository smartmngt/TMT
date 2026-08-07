# -*- coding: utf-8 -*-
"""
움/50-100 매매법 백테스트 API 서버 (Cloud Run) — 진단 강화판
==============================================================
- 데이터: pykrx (과거 시세)
- 두뇌  : strategy.py (KIS 자동매매에서 재사용)
- 재실행 속도를 위해 시세를 디스크 캐시(/tmp)에 저장

이 버전의 핵심 변경(원인 노출용)
  1) /backtest 전체를 하나의 try로 감쌈 -> body 파싱·merge_params 실패도 원인이 응답에 찍힘
  2) 응답 error에 "step" 태그 -> 어느 단계에서 죽었는지 즉시 식별
  3) pykrx 종목/시총 조회 재시도 + 실패 원인 문자열 수집
  4) 첫 종목 리스트가 비면 "왜 비었는지"를 그대로 반환

v0803.011 변경
  - 정적 파일 서빙 추가: index.html(자산관리 셸) + 아이콘 + manifest.json + backtest.html
    ("/"는 기존대로 index.html, 나머지 정적파일은 하단 static_files 라우트가 처리)

v0806.001 변경 (보유세/부동산 탭)
  - /addr      : 행정안전부 도로명주소 검색API 프록시 (주소 검색)
  - /gongsiga  : 국토교통부 공동주택가격정보 프록시 (공시가격 조회)
  - /gongsiga_raw : 응답 필드명 확인용 임시 라우트 (확인 후 삭제 가능)
  * 환경변수 필요: JUSO_KEY, VWORLD_KEY  (Cloud Run > 변수 및 보안 비밀)
  * 리포가 Public이므로 키는 절대 코드에 넣지 말 것
"""

import os
import time
import pickle
import threading
import traceback
from datetime import datetime
import math

from flask import Flask, request, jsonify, send_from_directory, abort
from flask_cors import CORS

# 배포 버전 (코드 바꿀 때마다 여기 숫자를 올린다. 화면·응답에 찍혀서 배포 확인용)
BACKEND_VERSION = "v0807.002"

app = Flask(__name__)
# NaN/Infinity가 응답에 섞이면 표준 JSON이 아니라 브라우저가 파싱 실패한다.
# 아래에서 직접 정리(sanitize)한 뒤 내보내므로, Flask 기본 인코더도 엄격 모드로 둔다.
app.config["JSON_SORT_KEYS"] = False
CORS(app)

CACHE_DIR = "/tmp/ohlcv_cache"
os.makedirs(CACHE_DIR, exist_ok=True)


def _clean(obj):
    """
    응답 데이터에서 NaN / Infinity / -Infinity 를 None(=JSON null)으로 치환.
    dict/list 중첩 구조를 재귀적으로 정리한다. (표준 JSON 호환 보장)
    """
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    # numpy 스칼라 등 float 유사 타입 방어
    try:
        import numpy as _np
        if isinstance(obj, _np.floating):
            f = float(obj)
            return None if (math.isnan(f) or math.isinf(f)) else f
        if isinstance(obj, _np.integer):
            return int(obj)
    except Exception:
        pass
    return obj


def safe_jsonify(payload, status=200):
    """NaN/Inf 정리 후 jsonify. 이걸 통해서만 결과를 내보낸다."""
    return jsonify(_clean(payload)), status


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


# ---------------------------------------------------------------------
# 데이터 (pykrx) - 캐시 + 재시도
# ---------------------------------------------------------------------
def _cache_path(ticker, start, end):
    return os.path.join(CACHE_DIR, f"{ticker}_{start}_{end}.pkl")


def _retry(fn, tries=3, delay=0.7):
    """pykrx 호출은 KRX 서버 사정으로 간헐 실패 -> 짧게 재시도. 마지막 예외는 올림."""
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


def get_ohlcv(stock, ticker, start, end):
    cp = _cache_path(ticker, start, end)
    if os.path.exists(cp):
        try:
            with open(cp, "rb") as f:
                return pickle.load(f)
        except Exception:
            pass
    try:
        df = _retry(lambda: stock.get_market_ohlcv(start, end, ticker), tries=2, delay=0.5)
    except Exception:
        return None
    if df is None or df.empty:
        return None
    df = df.rename(columns={
        "시가": "open", "고가": "high", "저가": "low",
        "종가": "close", "거래량": "volume", "거래대금": "value",
    })
    keep = [c for c in ("open", "high", "low", "close", "volume") if c in df.columns]
    df = df[keep]
    try:
        # 병렬 스레드가 같은 파일에 동시에 쓰다 손상되지 않도록 임시파일 후 교체(atomic)
        tmp = f"{cp}.{os.getpid()}.{threading.get_ident()}.tmp"
        with open(tmp, "wb") as f:
            pickle.dump(df, f)
        os.replace(tmp, cp)
    except Exception:
        pass
    return df


# 종목명 캐시 (FDR 리스팅에서 한 번에 채움 -> pykrx get_market_ticker_name 호출 최소화)
_NAME_MAP = {}


def _fdr_market_label(m):
    """앱에서 넘어오는 'KOSPI'/'KOSDAQ' -> FDR StockListing 심볼."""
    m = (m or "").upper()
    if m in ("KOSPI", "KOSDAQ", "KONEX", "KRX"):
        return m
    return "KRX"


def build_universe_fdr(markets, cap, diag):
    """
    FinanceDataReader로 유니버스 구성 (pykrx의 종목리스트/시총 버그 우회).
    StockListing은 시가총액(Marcap) 순으로 정렬되어 반환된다.
    컬럼: Code, Name, Market, Marcap 등.
    """
    import FinanceDataReader as fdr

    frames = []
    for m in markets:
        label = _fdr_market_label(m)
        df = _retry(lambda label=label: fdr.StockListing(label), tries=3, delay=0.8)
        if df is None or len(df) == 0:
            diag["per_market"][m] = 0
            diag["errors"].append(f"{m}: FDR StockListing 빈 결과")
            continue
        diag["per_market"][m] = int(len(df))
        frames.append(df)

    if not frames:
        return []

    import pandas as pd
    alldf = pd.concat(frames, ignore_index=True)

    # 컬럼명 방어 (버전에 따라 대소문자/이름이 다를 수 있음)
    code_col = next((c for c in ("Code", "code", "Symbol", "종목코드") if c in alldf.columns), None)
    name_col = next((c for c in ("Name", "name", "종목명") if c in alldf.columns), None)
    cap_col = next((c for c in ("Marcap", "MarCap", "marcap", "시가총액") if c in alldf.columns), None)

    if code_col is None:
        diag["errors"].append(f"FDR 컬럼에서 종목코드 못 찾음: {list(alldf.columns)}")
        return []

    # 중복 제거 (KRX 라벨이면 KOSPI/KOSDAQ 섞여 있음)
    alldf = alldf.drop_duplicates(subset=[code_col])

    # 시총 내림차순 정렬 (컬럼 있으면)
    if cap_col is not None:
        try:
            alldf = alldf.sort_values(cap_col, ascending=False)
        except Exception:
            pass

    # 6자리 숫자 티커만 (우선주/펀드/스팩 등 이상치 최소화)
    codes = []
    for _, row in alldf.iterrows():
        code = str(row[code_col]).strip().zfill(6)
        if len(code) == 6 and code.isdigit():
            codes.append(code)
            if name_col is not None:
                _NAME_MAP[code] = str(row[name_col])

    diag["unique_tickers"] = len(codes)
    ordered = codes[:cap] if cap and cap > 0 else codes
    diag["ordered"] = len(ordered)
    return ordered


def build_universe_pykrx(stock, markets, end, cap, diag):
    """폴백: pykrx로 유니버스 (버그 있으면 여기서도 실패할 수 있음)."""
    tickers = []
    for m in markets:
        try:
            got = _retry(lambda m=m: stock.get_market_ticker_list(end, market=m), tries=2, delay=0.7)
            got = got or []
            diag.setdefault("per_market_pykrx", {})[m] = len(got)
            tickers += got
        except Exception as e:
            diag["errors"].append(f"pykrx {m}: {e.__class__.__name__}: {e}")
    tickers = list(set(tickers))
    if not tickers:
        return []
    try:
        cap_df = _retry(lambda: stock.get_market_cap(end), tries=2, delay=0.7)
        if cap_df is None or cap_df.empty or "시가총액" not in cap_df.columns:
            raise ValueError("market_cap 비어있음")
        cap_df = cap_df[cap_df.index.isin(tickers)].sort_values("시가총액", ascending=False)
        ordered = list(cap_df.index)
    except Exception as e:
        diag["errors"].append(f"pykrx market_cap: {e.__class__.__name__}: {e}")
        ordered = tickers
    return ordered[:cap] if cap and cap > 0 else ordered


def build_universe(stock, markets, end, cap):
    """
    유니버스 구성. 1순위 FinanceDataReader(안정), 실패 시 pykrx 폴백.
    반환: (ordered_tickers, diag)
    """
    diag = {"per_market": {}, "errors": [], "source": None}

    # 1) FinanceDataReader
    try:
        ordered = build_universe_fdr(markets, cap, diag)
        if ordered:
            diag["source"] = "FinanceDataReader"
            return ordered, diag
    except Exception as e:
        diag["errors"].append(f"FDR: {e.__class__.__name__}: {e}")

    # 2) 폴백: pykrx
    try:
        ordered = build_universe_pykrx(stock, markets, end, cap, diag)
        if ordered:
            diag["source"] = "pykrx(fallback)"
            return ordered, diag
    except Exception as e:
        diag["errors"].append(f"pykrx-fallback: {e.__class__.__name__}: {e}")

    return [], diag


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
        # 화면이 버전을 알 수 있도록 백엔드 버전을 주입(선택). 앱은 /status로도 확인 가능.
        return html, 200, {"Content-Type": "text/html; charset=utf-8"}
    except Exception as e:
        # index.html이 없으면 상태 JSON으로 폴백
        return jsonify({"service": "woom-backtest", "status": "ok",
                        "version": BACKEND_VERSION, "note": f"index.html 없음: {e}",
                        "time": datetime.now().isoformat()})


@app.route("/status")
def status():
    """상태·버전 확인용 JSON. 환경변수 설정 여부도 함께 노출(값은 가림)."""
    def mask(v):
        if not v:
            return None
        return (v[:4] + "..." + v[-4:]) if len(v) > 10 else "설정됨"
    return jsonify({"service": "woom-backtest", "status": "ok",
                    "version": BACKEND_VERSION,
                    "gongsiga_mode": "vworld-ned",   # NED 속성조회 방식인지 확인용
                    "env": {"VWORLD_KEY": mask(VWORLD_KEY),
                            "VWORLD_DOMAIN": os.environ.get("VWORLD_DOMAIN") or None},
                    "time": datetime.now().isoformat()})


@app.route("/health")
def health():
    return jsonify({"status": "healthy"})


@app.route("/diag")
def diag():
    """의존성/환경 즉시 점검용. 브라우저에서 열어보면 됨."""
    out = {"time": datetime.now().isoformat()}
    try:
        import pykrx
        out["pykrx_version"] = getattr(pykrx, "__version__", "unknown")
    except Exception as e:
        out["pykrx_import"] = f"FAIL: {e.__class__.__name__}: {e}"
    try:
        import strategy as S  # noqa
        out["strategy_import"] = "ok"
        out["strategy_has_merge_params"] = hasattr(S, "merge_params")
        out["strategy_has_backtest_df"] = hasattr(S, "backtest_df")
        out["strategy_has_aggregate"] = hasattr(S, "aggregate")
    except Exception as e:
        out["strategy_import"] = f"FAIL: {e.__class__.__name__}: {e}"
    return jsonify(out)


@app.route("/diag2")
def diag2():
    """
    브라우저 주소창에서 그냥 열어보는 진단.
    pykrx가 실제로 KRX에서 데이터를 받아오는지 단계별로 시도하고,
    실패하면 '정확한 예외 클래스+메시지'를 그대로 보여줌.
    쿼리:  /diag2?date=20260428   (기본값은 오늘)
    """
    from datetime import datetime as _dt
    date = request.args.get("date") or _dt.now().strftime("%Y%m%d")
    out = {"date_used": date, "steps": {}}

    try:
        from pykrx import stock
    except Exception as e:
        out["steps"]["import"] = f"FAIL: {e.__class__.__name__}: {e}"
        return jsonify(out)
    out["steps"]["import"] = "ok"

    # 1) KOSPI 종목 리스트
    try:
        t0 = time.time()
        kospi = stock.get_market_ticker_list(date, market="KOSPI")
        out["steps"]["KOSPI_ticker_list"] = {
            "count": len(kospi or []),
            "sample": (kospi or [])[:5],
            "sec": round(time.time() - t0, 2),
        }
    except Exception as e:
        out["steps"]["KOSPI_ticker_list"] = f"FAIL: {e.__class__.__name__}: {e}"

    # 2) 시가총액
    try:
        t0 = time.time()
        cap = stock.get_market_cap(date)
        out["steps"]["market_cap"] = {
            "rows": int(getattr(cap, "shape", [0])[0]) if cap is not None else 0,
            "sec": round(time.time() - t0, 2),
        }
    except Exception as e:
        out["steps"]["market_cap"] = f"FAIL: {e.__class__.__name__}: {e}"

    # 3) 개별 시세 (삼성전자 005930)
    try:
        t0 = time.time()
        df = stock.get_market_ohlcv("20260101", date, "005930")
        out["steps"]["ohlcv_005930"] = {
            "rows": int(getattr(df, "shape", [0])[0]) if df is not None else 0,
            "sec": round(time.time() - t0, 2),
        }
    except Exception as e:
        out["steps"]["ohlcv_005930"] = f"FAIL: {e.__class__.__name__}: {e}"

    # 4) 아웃바운드 네트워크 자체 점검 (KRX 도메인으로 직접 연결 시도)
    try:
        import urllib.request
        t0 = time.time()
        req = urllib.request.Request(
            "http://data.krx.co.kr/",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=8) as r:
            out["steps"]["raw_krx_connect"] = {
                "http_status": r.status,
                "sec": round(time.time() - t0, 2),
            }
    except Exception as e:
        out["steps"]["raw_krx_connect"] = f"FAIL: {e.__class__.__name__}: {e}"

    # 5) FinanceDataReader 유니버스 (새 유니버스 소스) 점검
    try:
        import FinanceDataReader as fdr
        t0 = time.time()
        kospi = fdr.StockListing("KOSPI")
        out["steps"]["fdr_KOSPI"] = {
            "count": int(len(kospi)) if kospi is not None else 0,
            "columns": list(kospi.columns) if kospi is not None else [],
            "sec": round(time.time() - t0, 2),
        }
    except Exception as e:
        out["steps"]["fdr_KOSPI"] = f"FAIL: {e.__class__.__name__}: {e}"

    return jsonify(out)


@app.route("/backtest", methods=["POST"])
def backtest():
    # ---- 0) 의존성 import (여기서 죽으면 step=import) ----
    try:
        from pykrx import stock
    except Exception as e:
        return _err("import_pykrx", e)
    try:
        import strategy as S
    except Exception as e:
        return _err("import_strategy", e)

    # ---- 1) 요청 파싱 + 파라미터 (기존엔 try 밖이라 원인이 안 찍혔음) ----
    try:
        body = request.get_json(force=True, silent=True) or {}
        markets = body.get("markets", ["KOSPI", "KOSDAQ"])
        start = str(body.get("start", "20150101"))
        end = str(body.get("end", "20251231"))
        cap = int(body.get("universe_cap", 200))
    except Exception as e:
        return _err("parse_body", e)

    try:
        p = S.merge_params(body.get("params"))
    except Exception as e:
        return _err("merge_params", e)

    # ---- 2) 유니버스 ----
    try:
        universe, uni_diag = build_universe(stock, markets, end, cap)
    except Exception as e:
        return _err("build_universe", e)

    if not universe:
        # 왜 비었는지 그대로 반환 -> 네트워크/버전/날짜 즉시 판별 가능
        return jsonify({
            "error": "종목 목록을 가져오지 못했습니다.",
            "step": "build_universe_empty",
            "diag": uni_diag,
            "hint": ("per_market이 모두 0이고 errors에 URLError/Timeout류면 Cloud Run 아웃바운드 차단, "
                     "errors가 KeyError/JSONDecodeError류면 pykrx 버전 vs KRX API 불일치, "
                     "end가 휴장일이면 빈 결과가 날 수 있음(직전 영업일로 시도)."),
        }), 500

    # ---- 3) 스캔 + 백테스트 (순차 처리: 재현성 100% 보장) ----
    try:
        all_trades = []
        scanned = 0
        empty_ohlcv = 0
        # 종목을 항상 같은 순서로 처리 -> 캐시 경쟁/순서 흔들림 제거, 결과 재현 보장.
        for tk in sorted(universe):
            df = get_ohlcv(stock, tk, start, end)
            scanned += 1
            if df is None:
                empty_ohlcv += 1
                continue
            name = _NAME_MAP.get(tk)
            if not name:
                try:
                    name = stock.get_market_ticker_name(tk)
                except Exception:
                    name = ""
            all_trades += S.backtest_df(df, p, ticker=tk, name=name)
    except Exception as e:
        return _err("scan", e, extra={"scanned": scanned})

    # ---- 4) 집계 ----
    try:
        # 병렬 스캔은 종목 완료 순서가 매번 다르다 -> 집계 전에 (날짜, 종목) 순으로 정렬해
        # MDD/총수익(순차복리)이 항상 동일하게(재현가능) 나오도록 고정한다.
        all_trades.sort(key=lambda t: (t.get("date", ""), t.get("ticker", "")))
        agg = S.aggregate(all_trades)
        trades_sorted = sorted(all_trades, key=lambda x: x["retA"], reverse=True)
        agg["top_trades"] = trades_sorted[:15]
        agg["worst_trades"] = trades_sorted[-15:][::-1]
        agg["meta"] = {
            "version": BACKEND_VERSION,
            "scanned": scanned,
            "empty_ohlcv": empty_ohlcv,
            "universe": len(universe),
            "markets": markets,
            "start": start, "end": end,
            "params": p,
            "universe_diag": uni_diag,
        }
        return safe_jsonify(agg)
    except Exception as e:
        return _err("aggregate", e, extra={"scanned": scanned, "n_trades": len(all_trades)})


# ---------------------------------------------------------------------
# 종목 검색 / 환율 (자산관리 앱용) — FinanceDataReader 사용
#   - /search?q=리&market=all|us|kr  -> 종목 자동완성
#   - /fxrate?date=YYYYMMDD          -> 그날(또는 직전영업일) USD/KRW 종가
#   기존 백테스트/pykrx 로직과 독립. FDR은 이미 requirements에 있음.
# ---------------------------------------------------------------------
_SEARCH_CACHE = {"rows": None}          # [{ticker,name,market,currency}]
_SEARCH_LOCK = threading.Lock()
_SEARCH_DISK = os.path.join(CACHE_DIR, "search_rows_v2.pkl")

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
}

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
        score = None
        if r["ticker"].upper() in alias_tickers:
            score = 0                      # 한글 별칭 정확 매칭 최우선
        elif tk == ql:
            score = 1
        elif tk.startswith(ql):
            score = 2
        elif nm.startswith(ql):
            score = 3
        elif (not hangul and ql in tk):
            score = 4
        elif ql in nm:
            score = 5
        if score is not None:
            scored.append((score, len(r["name"]), r))

    scored.sort(key=lambda x: (x[0], x[1]))
    out = [r for _, _, r in scored[:20]]

    # 폴백: 상장리스트에 없지만 유효한 미국 티커(ETF 등)면 yfinance로 확인해 반환
    if not out and not hangul:
        import re as _re
        if _re.match(r"^[A-Za-z.\-]{1,6}$", q):
            try:
                import yfinance as yf
                sym = q.upper()
                info = {}
                try:
                    info = yf.Ticker(sym).get_info()
                except Exception:
                    info = getattr(yf.Ticker(sym), "info", {}) or {}
                nm = info.get("shortName") or info.get("longName")
                if nm:
                    out = [{"ticker": sym, "name": nm,
                            "market": info.get("exchange") or "US", "currency": "USD"}]
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
        if df is None or df.empty:
            return jsonify({"error": "환율 데이터 없음", "date": end}), 404
        col = "Close" if "Close" in df.columns else df.columns[-1]
        rate = float(df[col].iloc[-1])
        used = str(df.index[-1])[:10]
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
    if m in ("KOSPI", "KRX", ""):
        return [ticker + ".KS", ticker + ".KQ"]
    if m == "KOSDAQ":
        return [ticker + ".KQ", ticker + ".KS"]
    return [ticker]  # 미국


@app.route("/price")
def price():
    """현재가(최근 종가). ?ticker=O&market=NYSE  (미국) / ?ticker=005930&market=KRX (국내)"""
    ticker = (request.args.get("ticker") or "").strip()
    market = (request.args.get("market") or "").strip()
    if not ticker:
        return jsonify({"error": "ticker 필요"}), 400
    # 1) FinanceDataReader 우선(이미 설치됨)
    try:
        import FinanceDataReader as fdr
        from datetime import datetime as _dt, timedelta
        start = (_dt.now() - timedelta(days=10)).strftime("%Y-%m-%d")
        syms = _yf_symbol(ticker, market)
        base = ticker if (market or "").upper() not in ("KOSPI", "KOSDAQ", "KRX", "") else ticker
        for sym in [base]:
            try:
                df = _retry(lambda sym=sym: fdr.DataReader(sym, start), tries=1, delay=0.4)
                if df is not None and not df.empty and "Close" in df.columns:
                    return jsonify({"ticker": ticker, "price": round(float(df["Close"].iloc[-1]), 4),
                                    "date": str(df.index[-1])[:10], "source": "fdr"})
            except Exception:
                pass
    except Exception:
        pass
    # 2) yfinance 폴백(있으면)
    try:
        import yfinance as yf
        for sym in _yf_symbol(ticker, market):
            try:
                h = yf.Ticker(sym).history(period="7d")
                if h is not None and not h.empty:
                    return jsonify({"ticker": ticker, "price": round(float(h["Close"].iloc[-1]), 4),
                                    "date": str(h.index[-1])[:10], "source": "yfinance", "symbol": sym})
            except Exception:
                pass
    except Exception:
        pass
    return jsonify({"error": "현재가 조회 실패", "ticker": ticker}), 404


@app.route("/dividends")
def dividends():
    """공개 배당이력(주당배당금). ?ticker=O&market=NYSE&years=3
       반환: [{date:'YYYY-MM-DD', perShare: float}]  (오래된→최근)
       yfinance 필요(없으면 안내). 실입금액과 다를 수 있어 앱에서 수정."""
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
                    out.append({"date": str(idx)[:10], "perShare": round(float(val), 6)})
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
        rows, used = _ned_apart_price(pnu, year)
        if not rows:
            return jsonify({"year": year, "price": 0,
                            "note": "해당 PNU·연도로 조회 결과 없음", "endpoint": used})

        cand = rows
        # 동 → 호 순서로 좁힌다 (없으면 전체 유지)
        if dong:
            f1 = [r for r in cand if _digits(_pick(r, "dong")) == _digits(dong)]
            if f1:
                cand = f1
        if ho:
            f2 = [r for r in cand if _digits(_pick(r, "ho")) == _digits(ho)]
            if f2:
                cand = f2

        r0 = cand[0]
        price = _digits(_pick(r0, "price"))
        return jsonify({
            "year": year,
            "price": int(price) if price else 0,
            "matched": {"dong": _pick(r0, "dong"), "ho": _pick(r0, "ho"),
                        "area": _pick(r0, "area")},
            "count": len(cand), "total": len(rows), "endpoint": used,
        })
    except Exception as e:
        return _err("gongsiga", e)


# NED 응답에서 값 꺼내기 (필드명이 버전마다 달라 유연하게 매칭)
_FIELD_HINTS = {
    "dong":  ("dongnm", "dong", "bldngnm"),
    "ho":    ("honm", "ho", "hosunm"),
    "price": ("pblntfpc", "pc", "price", "prc", "amt", "gongsi"),
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


def _ned_apart_price(pnu, year):
    """
    공동주택가격 속성조회.
    format=json 우선, 실패 시 xml 파싱. 엔드포인트 후보를 순서대로 시도.
    반환: (행 리스트, 사용한 엔드포인트)
    """
    import json as _json

    names = ["getApartHousingPriceAttr", "getApartHousingPrice"]
    last = None
    for name in names:
        for fmt in ("json", "xml"):
            try:
                status, body = _http_text(
                    f"https://api.vworld.kr/ned/data/{name}",
                    {"key": VWORLD_KEY,
                     "domain": os.environ.get("VWORLD_DOMAIN", ""),
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
                return rows, f"{name}:{fmt}"
    if last:
        raise last
    return [], names[0]


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

    out = {"pnu": pnu, "year": year, "tried": {}}
    for name in ("getApartHousingPriceAttr", "getApartHousingPrice"):
        for fmt in ("json", "xml"):
            tag = f"{name}:{fmt}"
            try:
                status, body = _http_text(
                    f"https://api.vworld.kr/ned/data/{name}",
                    {"key": VWORLD_KEY,
                     "domain": os.environ.get("VWORLD_DOMAIN", ""),
                     "pnu": pnu, "stdrYear": str(year),
                     "format": fmt, "numOfRows": 20, "pageNo": 1})
                out["tried"][tag] = {"status": status,
                                     "len": len(body),
                                     "body": body[:1200]}
            except Exception as e:
                out["tried"][tag] = {"error": f"{e.__class__.__name__}: {e}"}
    return jsonify(out)


# ---------------------------------------------------------------------
# 정적 파일 서빙 (자산관리 셸 · 아이콘 · manifest · backtest.html)
#   - "/"는 위에서 index.html을 직접 서빙
#   - 아래 라우트는 나머지 정적파일만 처리 (icon-*.png, manifest.json, backtest.html 등)
#   - 명시 라우트(/status, /backtest, /health, /diag, /diag2, /addr, /gongsiga)가
#     우선 매칭되므로 충돌 없음
#   - 화이트리스트 확장자만 허용 -> app.py / strategy.py 등 소스는 노출되지 않음
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
