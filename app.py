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
"""

import os
import time
import pickle
import traceback
from datetime import datetime

from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

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
        with open(cp, "wb") as f:
            pickle.dump(df, f)
    except Exception:
        pass
    return df


def build_universe(stock, markets, end, cap):
    """
    시가총액 상위 cap 종목.
    반환: (ordered_tickers, diag)  diag는 왜 비었는지 등 진단 정보.
    """
    diag = {"per_market": {}, "errors": []}
    tickers = []
    for m in markets:
        try:
            got = _retry(lambda m=m: stock.get_market_ticker_list(end, market=m), tries=3, delay=0.7)
            got = got or []
            diag["per_market"][m] = len(got)
            tickers += got
        except Exception as e:
            diag["per_market"][m] = 0
            diag["errors"].append(f"{m}: {e.__class__.__name__}: {e}")

    tickers = list(set(tickers))
    diag["unique_tickers"] = len(tickers)
    if not tickers:
        return [], diag

    try:
        cap_df = _retry(lambda: stock.get_market_cap(end), tries=3, delay=0.7)
        cap_df = cap_df[cap_df.index.isin(tickers)].sort_values("시가총액", ascending=False)
        ordered = list(cap_df.index)
    except Exception as e:
        diag["errors"].append(f"market_cap: {e.__class__.__name__}: {e}")
        ordered = tickers  # 시총 정렬 실패해도 진행

    ordered = ordered[:cap] if cap and cap > 0 else ordered
    diag["ordered"] = len(ordered)
    return ordered, diag


# ---------------------------------------------------------------------
# 라우트
# ---------------------------------------------------------------------
@app.route("/")
def root():
    return jsonify({"service": "woom-backtest", "status": "ok",
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

    # ---- 3) 스캔 + 백테스트 ----
    try:
        all_trades = []
        scanned = 0
        empty_ohlcv = 0
        for tk in universe:
            df = get_ohlcv(stock, tk, start, end)
            scanned += 1
            if df is None:
                empty_ohlcv += 1
                continue
            try:
                name = stock.get_market_ticker_name(tk)
            except Exception:
                name = ""
            all_trades += S.backtest_df(df, p, ticker=tk, name=name)
    except Exception as e:
        return _err("scan", e, extra={"scanned": scanned})

    # ---- 4) 집계 ----
    try:
        agg = S.aggregate(all_trades)
        trades_sorted = sorted(all_trades, key=lambda x: x["retA"], reverse=True)
        agg["top_trades"] = trades_sorted[:15]
        agg["worst_trades"] = trades_sorted[-15:][::-1]
        agg["meta"] = {
            "scanned": scanned,
            "empty_ohlcv": empty_ohlcv,
            "universe": len(universe),
            "markets": markets,
            "start": start, "end": end,
            "params": p,
            "universe_diag": uni_diag,
        }
        return jsonify(agg)
    except Exception as e:
        return _err("aggregate", e, extra={"scanned": scanned, "n_trades": len(all_trades)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
