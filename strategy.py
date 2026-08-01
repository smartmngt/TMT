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

    # ---- 진입 조건 개별 on/off (교집합 실험용) ----
    # 켠 조건만 AND로 결합된다. 하나씩 켜고 끄며 각 조건의 기여를 측정.
    "use_trend": True,       # 50<100선 & 100선 우하향 (하락 후 바닥)
    "use_gc": True,          # 10>20선 골든크로스
    "use_vol": True,         # 거래량 급증
    "use_price": True,       # 종가 > 10일선 & 양봉
    "use_box": True,         # 박스권 바닥 위치
    "use_rsi": True,         # RSI 과매도
    "use_stoch": False,      # 스토캐스틱 힐로 (강의 원본, 기본 off)
    "use_cci": False,        # CCI (강의 원본, 기본 off)
    "use_liq": True,         # 최소 가격/거래대금 필터

    # 조건 "최근 N봉 이내 발생" 허용 (강의의 '골든크로스 나고 안착' 유연성 반영)
    "gc_within": 5,          # 골든크로스가 최근 N봉 이내에 있었으면 OK
    "vol_within": 3,         # 거래량 급증이 최근 N봉 이내에 있었으면 OK
    "box_at_shift": 0,       # 박스 바닥 위치를 N봉 전 시점에서 판정(0=당일 엄격, 5=국면)

    # ---- RSI ----
    "rsi_len": 6,
    "rsi_oversold": 30,
    "rsi_recent": 5,

    # ---- 스토캐스틱 힐로 (강의: 25, 6) ----
    "stoch_k": 25,
    "stoch_d": 6,
    "stoch_thresh": 20,      # %K가 이 값 미만이면 과매도(우물)
    "stoch_recent": 5,

    # ---- CCI (강의: 9.8 -> 정수 10으로 근사) ----
    "cci_len": 10,
    "cci_thresh": -100,      # CCI가 이 값 미만이면 과매도(우물)
    "cci_recent": 5,

    # ---- 청산/시뮬 ----
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


def stoch_k(df: pd.DataFrame, k_len: int, d_len: int):
    """
    스토캐스틱 (강의의 '스토캐스틱 힐로' 근사).
    %K = (종가 - 기간최저) / (기간최고 - 기간최저) * 100, 그 뒤 d_len 이동평균으로 평활.
    """
    low_min = df["low"].rolling(k_len).min()
    high_max = df["high"].rolling(k_len).max()
    rng = (high_max - low_min).replace(0, np.nan)
    raw_k = (df["close"] - low_min) / rng * 100
    return raw_k.rolling(d_len).mean()


def cci(df: pd.DataFrame, length: int) -> pd.Series:
    """CCI(Commodity Channel Index). 강의의 CCR/CCI 근사."""
    tp = (df["high"] + df["low"] + df["close"]) / 3
    ma = tp.rolling(length).mean()
    md = (tp - ma).abs().rolling(length).mean().replace(0, np.nan)
    return (tp - ma) / (0.015 * md)


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
    # 강의 원본 지표 (기본 off, 켜면 계산됨)
    if p.get("use_stoch"):
        df["stoch"] = stoch_k(df, p["stoch_k"], p["stoch_d"])
    if p.get("use_cci"):
        df["cci"] = cci(df, p["cci_len"])
    return df


# ---------------------------------------------------------------------
# 진입 신호
# ---------------------------------------------------------------------
def condition_masks(df: pd.DataFrame, p: dict) -> dict:
    """각 조건을 개별 boolean Series로 반환. 어떤 조건이 얼마나 거르는지 분석 가능."""
    c = df["close"]
    idx = df.index

    def _t():  # trend: 하락 후 바닥 (50<100선 & 100선 우하향)
        return (df["ma50"] < df["ma100"]) & \
               (df["ma100"] < df["ma100"].shift(p["ma_trend_lookback"]))

    def _gc():  # 10>20 골든크로스 (최근 N봉 이내 발생 허용)
        cross = (df["ma10"] > df["ma20"]) & (df["ma10"].shift(1) <= df["ma20"].shift(1))
        w = int(p.get("gc_within", 1))
        if w > 1:
            cross = cross.rolling(w).max().astype(bool)  # 최근 w봉 내 크로스 있었으면 True
        # 크로스 후에도 정배열(10>20) 유지 중일 때만
        return cross & (df["ma10"] > df["ma20"])

    def _vol():  # 거래량 급증 (최근 N봉 이내 발생 허용)
        spike = df["volume"] > (df["volma20"] * p["vol_mult"])
        w = int(p.get("vol_within", 1))
        if w > 1:
            spike = spike.rolling(w).max().astype(bool)
        return spike

    def _price():  # 종가 > 10일선 & 양봉
        return (c > df["ma10"]) & (c > df["open"])

    def _box():  # 박스권 바닥 위치 (N봉 전 시점에서 판정 가능)
        rng = (df["box_hi"] - df["box_lo"]).replace(0, np.nan)
        pos = (c - df["box_lo"]) / rng
        sh = int(p.get("box_at_shift", 0))
        if sh > 0:
            pos = pos.shift(sh)  # sh봉 전의 바닥 위치를 본다(그때 바닥이었나)
        return pos < p["box_pos_thresh"]

    def _rsi():  # RSI 과매도 (최근 N봉 중 저점)
        return df["rsi6"].rolling(p["rsi_recent"]).min() < p["rsi_oversold"]

    def _stoch():  # 스토캐스틱 과매도 (우물)
        if "stoch" not in df.columns:
            return pd.Series(True, index=idx)
        return df["stoch"].rolling(p["stoch_recent"]).min() < p["stoch_thresh"]

    def _cci():  # CCI 과매도 (우물)
        if "cci" not in df.columns:
            return pd.Series(True, index=idx)
        return df["cci"].rolling(p["cci_recent"]).min() < p["cci_thresh"]

    def _liq():  # 최소 유동성
        return (c > p["min_price"]) & (df["valma20"] > p["min_turnover"])

    return {
        "trend": _t(), "gc": _gc(), "vol": _vol(), "price": _price(),
        "box": _box(), "rsi": _rsi(), "stoch": _stoch(), "cci": _cci(), "liq": _liq(),
    }


# 조건 이름 -> use_ 플래그 매핑
_COND_FLAGS = {
    "trend": "use_trend", "gc": "use_gc", "vol": "use_vol", "price": "use_price",
    "box": "use_box", "rsi": "use_rsi", "stoch": "use_stoch", "cci": "use_cci",
    "liq": "use_liq",
}


def entry_signals(df: pd.DataFrame, p: dict) -> pd.Series:
    masks = condition_masks(df, p)
    sig = pd.Series(True, index=df.index)
    for name, flag in _COND_FLAGS.items():
        if p.get(flag, False):
            sig = sig & masks[name]
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
        peak = np.maximum.accumulate(eq)
        mdd = float(((eq - peak) / peak).min()) if len(r) else 0.0
        # skew는 표본 3개 미만이면 정의되지 않음(NaN) -> None 처리
        sk = pd.Series(r).skew() if len(r) >= 3 else np.nan
        sk = round(float(sk), 3) if sk == sk else None  # NaN이면 None
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
            "skew": sk,
            "mdd": round(mdd, 4),
            "equity": [round(float(x), 4) for x in eq],
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
