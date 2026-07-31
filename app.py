# -*- coding: utf-8 -*-
"""
움/50-100 매매법 백테스트 API 서버 (Cloud Run)
==============================================
- 데이터: pykrx (과거 시세)
- 두뇌  : strategy.py (KIS 자동매매에서 재사용)
- 재실행 속도를 위해 시세를 디스크 캐시(/tmp)에 저장 -> 파라미터만 바꿔 다시 돌리면 빠름

엔드포인트
  GET  /            상태 확인
  GET  /health      헬스체크
  POST /backtest    백테스트 실행
      body(JSON): {
        markets: ["KOSPI","KOSDAQ"],
        start: "20150101", end: "20251231",
        universe_cap: 200,      # 시가총액 상위 N종목만 (실행시간 제한)
        params: { ...strategy 파라미터... }
      }
"""

import os
import pickle
import traceback
from datetime import datetime

from flask import Flask, request, jsonify
from flask_cors import CORS

import strategy as S

app = Flask(__name__)
CORS(app)  # 앱(HTML)에서 직접 호출 허용

CACHE_DIR = "/tmp/ohlcv_cache"
os.makedirs(CACHE_DIR, exist_ok=True)


# ---------------------------------------------------------------------
# 데이터 (pykrx) - 캐시 포함
# ---------------------------------------------------------------------
def _cache_path(ticker, start, end):
    return os.path.join(CACHE_DIR, f"{ticker}_{start}_{end}.pkl")


def get_ohlcv(stock, ticker, start, end):
    cp = _cache_path(ticker, start, end)
    if os.path.exists(cp):
        try:
            with open(cp, "rb") as f:
                return pickle.load(f)
        except Exception:
            pass
    try:
        df = stock.get_market_ohlcv(start, end, ticker)
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
    """시가총액 상위 cap 종목 (유동성·의미 있는 종목 위주, 실행시간 제한)"""
    tickers = []
    for m in markets:
        try:
            tickers += stock.get_market_ticker_list(end, market=m)
        except Exception:
            pass
    tickers = list(set(tickers))
    if not tickers:
        return []
    # 시총 순 정렬
    try:
        cap_df = stock.get_market_cap(end)
        cap_df = cap_df[cap_df.index.isin(tickers)].sort_values("시가총액", ascending=False)
        ordered = list(cap_df.index)
    except Exception:
        ordered = tickers
    return ordered[:cap] if cap and cap > 0 else ordered


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


@app.route("/backtest", methods=["POST"])
def backtest():
    try:
        from pykrx import stock
    except Exception as e:
        return jsonify({"error": f"pykrx import 실패: {e}"}), 500

    body = request.get_json(force=True, silent=True) or {}
    markets = body.get("markets", ["KOSPI", "KOSDAQ"])
    start = str(body.get("start", "20150101"))
    end = str(body.get("end", "20251231"))
    cap = int(body.get("universe_cap", 200))
    p = S.merge_params(body.get("params"))

    try:
        universe = build_universe(stock, markets, end, cap)
        if not universe:
            return jsonify({"error": "종목 목록을 가져오지 못했습니다."}), 500

        all_trades = []
        scanned = 0
        for tk in universe:
            df = get_ohlcv(stock, tk, start, end)
            scanned += 1
            if df is None:
                continue
            try:
                name = stock.get_market_ticker_name(tk)
            except Exception:
                name = ""
            all_trades += S.backtest_df(df, p, ticker=tk, name=name)

        agg = S.aggregate(all_trades)

        # 상위/하위 트레이드 (앱 표시용)
        trades_sorted = sorted(all_trades, key=lambda x: x["retA"], reverse=True)
        agg["top_trades"] = trades_sorted[:15]
        agg["worst_trades"] = trades_sorted[-15:][::-1]
        agg["meta"] = {
            "scanned": scanned,
            "universe": len(universe),
            "markets": markets,
            "start": start, "end": end,
            "params": p,
        }
        return jsonify(agg)

    except Exception as e:
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
