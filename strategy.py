# -*- coding: utf-8 -*-
"""
움(우물) / 50-100 매매법 - 신호 & 백테스트 두뇌
=================================================
데이터 소스에 독립적. DataFrame(open/high/low/close/volume)만 주면
- 지표 계산
- 진입 신호 판정
- 백테스트 시뮬레이션
을 수행한다.

이 모듈은 백테스트(pykrx)와 실시간/자동매매(KIS) 양쪽에서 그대로 재사용된다.
  - 백테스트: 과거 전체 DataFrame -> backtest_df()
  - 실시간  : 최근 N봉 DataFrame -> latest_signal()  (오늘 신호만 판정)
"""

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------
# 기본 파라미터 (프런트에서 덮어씀)
# ---------------------------------------------------------------------
DEFAULT_PARAMS = {
    "box_lookback": 480,     # 박스권 판정 기간(거래일) ~2년
    "box_pos_thresh": 0.25,  # 최근 종가가 (기간 저~고) 하위 % 이내면 바닥권
    "ma_trend_lookback": 5,  # 장기선 우하향 판정
    "vol_mult": 2.0,         # 거래량 급증 배수
    "use_rsi": True,
    "rsi_len": 6,
    "rsi_oversold": 30,
    "rsi_recent": 5,
    "target_pct": 0.10,      # +10% 익절
    "stop_pct": 0.07,        # 손절 -7% (B안)
    "use_ma20_stop": True,   # 20일선 이탈 손절 (B안)
    "max_hold": 40,          # 최대 보유(거래일)
    "fast_horizon": 10,      # "2주 내 +10%" 판정
    "entry_next_open": True, # 신호 다음날 시가 진입
    "min_price": 1000,
    "min_turnover": 3e8,     # 최근 20일 평균 거래대금 최소
}


def merge_params(user: dict | None) -> dict:
    p = dict(DEFAULT_PARAMS)
    if user:
        p.update({k: v for k, v in user.items() if v is not None})
    return p


# ---------------------------------------------------------------------
# 지표
# ---------------------------------------------------------------------
def rsi(series: pd.Series, length: int) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / length, min_periods=length).mean()
    avg_loss = loss.ewm(alpha=1 / length, min_periods=length).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)


def compute_indicators(df: pd.DataFrame, p: dict) -> pd.DataFrame:
    df = df.copy()
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df[df["close"] > 0]

    df["ma10"] = df["close"].rolling(10).mean()
    df["ma20"] = df["close"].rolling(20).mean()
    df["ma50"] = df["close"].rolling(50).mean()
    df["ma100"] = df["close"].rolling(100).mean()
    df["volma20"] = df["volume"].rolling(20).mean()
    df["valma20"] = (df["close"] * df["volume"]).rolling(20).mean()
    df["rsi6"] = rsi(df["close"], p["rsi_len"])
    df["box_lo"] = df["low"].rolling(p["box_lookback"]).min()
    df["box_hi"] = df["high"].rolling(p["box_lookback"]).max()
    return df


# ---------------------------------------------------------------------
# 진입 신호
# ---------------------------------------------------------------------
def entry_signals(df: pd.DataFrame, p: dict) -> pd.Series:
    c = df["close"]
    trend = (df["ma50"] < df["ma100"]) & \
            (df["ma100"] < df["ma100"].shift(p["ma_trend_lookback"]))
    gc = (df["ma10"] > df["ma20"]) & (df["ma10"].shift(1) <= df["ma20"].shift(1))
    vol = df["volume"] > (df["volma20"] * p["vol_mult"])
    price = (c > df["ma10"]) & (c > df["open"])
    rng = (df["box_hi"] - df["box_lo"]).replace(0, np.nan)
    pos = (c - df["box_lo"]) / rng
    box = pos < p["box_pos_thresh"]
    liq = (c > p["min_price"]) & (df["valma20"] > p["min_turnover"])

    sig = trend & gc & vol & price & box & liq
    if p["use_rsi"]:
        sig = sig & (df["rsi6"].rolling(p["rsi_recent"]).min() < p["rsi_oversold"])
    return sig.fillna(False)


# ---------------------------------------------------------------------
# 한 신호 시뮬레이션 (A안=손절없음 / B안=손절)
# ---------------------------------------------------------------------
def simulate(df: pd.DataFrame, i: int, p: dict):
    n = len(df)
    entry_idx = i + 1 if p["entry_next_open"] else i
    if entry_idx >= n:
        return None
    entry_px = df["open"].iloc[entry_idx] if p["entry_next_open"] else df["close"].iloc[i]
    if not entry_px or entry_px <= 0:
        return None

    tgt = entry_px * (1 + p["target_pct"])
    stp = entry_px * (1 - p["stop_pct"])
    resA = resB = None
    hit_fast = False

    for k in range(1, p["max_hold"] + 1):
        j = entry_idx + k
        if j >= n:
            break
        hi, lo, cl = df["high"].iloc[j], df["low"].iloc[j], df["close"].iloc[j]
        ma20 = df["ma20"].iloc[j]

        if hi >= tgt:
            if k <= p["fast_horizon"]:
                hit_fast = True
            if resA is None:
                resA = p["target_pct"]
            if resB is None:
                resB = p["target_pct"]
            if resA is not None and resB is not None:
                break

        if resB is None:
            if lo <= stp:
                resB = -p["stop_pct"]
            elif p["use_ma20_stop"] and not np.isnan(ma20) and cl < ma20:
                resB = (cl - entry_px) / entry_px

        if resA is not None and resB is not None:
            break

    last_j = min(entry_idx + p["max_hold"], n - 1)
    last_ret = (df["close"].iloc[last_j] - entry_px) / entry_px
    if resA is None:
        resA = last_ret
    if resB is None:
        resB = last_ret

    return {
        "date": str(df.index[i])[:10],
        "entry": round(float(entry_px), 2),
        "retA": round(float(resA), 4),
        "retB": round(float(resB), 4),
        "hit_fast": bool(hit_fast),
    }


# ---------------------------------------------------------------------
# 한 종목 백테스트
# ---------------------------------------------------------------------
def backtest_df(df: pd.DataFrame, p: dict, ticker: str = "", name: str = "") -> list:
    if df is None or len(df) < p["box_lookback"] + 20:
        return []
    df = compute_indicators(df, p)
    sig = entry_signals(df, p)
    out = []
    for i in np.where(sig.values)[0]:
        if i + 2 >= len(df):
            continue
        t = simulate(df, int(i), p)
        if t:
            t["ticker"] = ticker
            t["name"] = name
            out.append(t)
    return out


# ---------------------------------------------------------------------
# 실시간용: 마지막 봉이 신호인지
# ---------------------------------------------------------------------
def latest_signal(df: pd.DataFrame, p: dict) -> bool:
    if df is None or len(df) < p["box_lookback"] + 20:
        return False
    df = compute_indicators(df, p)
    sig = entry_signals(df, p)
    return bool(sig.iloc[-1])


# ---------------------------------------------------------------------
# 집계
# ---------------------------------------------------------------------
def aggregate(trades: list) -> dict:
    if not trades:
        return {"n": 0}
    tdf = pd.DataFrame(trades)

    def stat(col):
        r = tdf[col].values.astype(float)
        wins, losses = r[r > 0], r[r < 0]
        pf = wins.sum() / abs(losses.sum()) if losses.sum() != 0 else None
        eq = np.cumprod(1 + r)
        mdd = float(((eq - np.maximum.accumulate(eq)) / np.maximum.accumulate(eq)).min())
        return {
            "n": int(len(r)),
            "win_rate": round(float((r > 0).mean()), 4),
            "avg": round(float(r.mean()), 4),
            "median": round(float(np.median(r)), 4),
            "profit_factor": round(pf, 2) if pf is not None else None,
            "avg_win": round(float(wins.mean()), 4) if len(wins) else 0.0,
            "avg_loss": round(float(losses.mean()), 4) if len(losses) else 0.0,
            "worst": round(float(r.min()), 4),
            "best": round(float(r.max()), 4),
            "skew": round(float(pd.Series(r).skew()), 3),
            "mdd": round(mdd, 4),
            "equity": [round(float(x), 4) for x in np.cumprod(1 + r)],
        }

    return {
        "n": len(trades),
        "hit_fast_rate": round(float(tdf["hit_fast"].mean()), 4),
        "A": stat("retA"),  # 영상대로: 손절 없음
        "B": stat("retB"),  # 리스크관리: 손절
        "by_year": _by_year(tdf),
    }


def _by_year(tdf: pd.DataFrame) -> dict:
    tdf = tdf.copy()
    tdf["year"] = tdf["date"].str[:4]
    g = tdf.groupby("year")
    return {
        str(y): {
            "n": int(len(sub)),
            "win_rate_A": round(float((sub["retA"] > 0).mean()), 3),
            "avg_A": round(float(sub["retA"].mean()), 4),
        }
        for y, sub in g
    }
