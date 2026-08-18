// ============================================================
// StockBot - 한국/미국 주식 자동매매 웹앱
// KIS (한국투자증권) API 연동 — 국내 + 미국주식 지원
// ============================================================

// ============================================================
// ── 기술적 지표 계산 유틸 (RSI / MACD / 볼린저밴드)
// 모두 순수 함수 — 데이터 배열(close prices)을 받아 수치 반환
// ============================================================

/**
 * RSI(Relative Strength Index) 계산
 * @param {number[]} closes  종가 배열 (최신값이 마지막)
 * @param {number}   period  기간 (기본 14)
 * @returns {number} RSI 0~100
 */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50; // 데이터 부족 → 중립 50
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * EMA(지수이동평균) 계산
 * @param {number[]} closes  종가 배열
 * @param {number}   period  기간
 * @returns {number[]} EMA 배열
 */
function calcEMA(closes, period) {
  if (closes.length < period) return closes.map(() => closes[0]);
  const k = 2 / (period + 1);
  const ema = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

/**
 * MACD 계산 (12, 26, 9)
 * @param {number[]} closes  종가 배열
 * @returns {{ macd: number, signal: number, hist: number }}
 */
function calcMACD(closes) {
  if (closes.length < 35) return { macd: 0, signal: 0, hist: 0 };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calcEMA(macdLine, 9);
  const last = macdLine.length - 1;
  return {
    macd:   macdLine[last],
    signal: signalLine[last],
    hist:   macdLine[last] - signalLine[last],
  };
}

/**
 * 볼린저 밴드 계산 (20, 2σ)
 * @param {number[]} closes  종가 배열
 * @param {number}   period  기간 (기본 20)
 * @returns {{ upper, mid, lower, bw, pct }} bw=밴드폭%, pct=현재가 위치 0~1
 */
function calcBollinger(closes, period = 20) {
  if (closes.length < period) return { upper: 0, mid: 0, lower: 0, bw: 0, pct: 0.5 };
  const slice = closes.slice(-period);
  const mid   = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  const upper = mid + 2 * std;
  const lower = mid - 2 * std;
  const last  = closes[closes.length - 1];
  const bw    = mid > 0 ? ((upper - lower) / mid) * 100 : 0;
  const pct   = upper !== lower ? (last - lower) / (upper - lower) : 0.5;
  return { upper, mid, lower, bw, pct };
}

/**
 * 거래량 이동평균 배율 계산
 * @param {number[]} vols    거래량 배열
 * @param {number}   period  기간 (기본 20)
 * @returns {number} 최근 거래량 / 평균 거래량 배율
 */
function calcVolumeMult(vols, period = 20) {
  if (vols.length < 2) return 1;
  const slice  = vols.slice(-Math.min(period, vols.length));
  const avgVol = slice.slice(0, -1).reduce((a, b) => a + b, 0) / (slice.length - 1);
  return avgVol > 0 ? slice[slice.length - 1] / avgVol : 1;
}

/**
 * 매수 압력 계산: (고가-종가) / (고가-저가) — 1에 가까울수록 매도 압력
 * 반대로 (종가-저가) / (고가-저가) 를 매수압력으로 사용
 */
function calcBuyPressure(highs, lows, closes) {
  if (!highs.length) return 1;
  const last = highs.length - 1;
  const range = highs[last] - lows[last];
  return range > 0 ? (closes[last] - lows[last]) / range : 0.5;
}

/**
 * 종합 신호 점수 계산 (0~100)
 * RSI, MACD, 볼린저, 거래량 가중 합산
 */
function calcSignalScore(closes, highs, lows, volumes, strategy, ap) {
  const rsi     = calcRSI(closes, 14);
  const macd    = calcMACD(closes);
  const boll    = calcBollinger(closes, 20);
  const volMult = calcVolumeMult(volumes, 20);
  const buyPr   = calcBuyPressure(highs, lows, closes);

  let score = 50; // 기준점

  if (strategy === 'scalping') {
    // RSI 40~60: 중립 구간 가점
    const rsiOk = rsi >= ap.rsiMin && rsi <= ap.rsiMax;
    if (rsiOk)    score += 15;
    else if (rsi < 30 || rsi > 70) score -= 20; // 극단값 감점
    // MACD 히스토그램 방향
    if (macd.hist > 0) score += 12;
    else if (macd.hist < 0) score -= 10;
    // 볼린저 밴드 위치 (0.4~0.6: 중간, 매수 시 상승 여지 있음)
    if (boll.pct >= 0.2 && boll.pct <= 0.6) score += 8;
    else if (boll.pct > 0.8) score -= 15; // 밴드 상단 근처 → 과매수
    // 거래량 배수
    if (volMult >= ap.volMult) score += 10;
    // 매수 압력
    if (buyPr >= ap.buyPressure) score += 8;
  } else if (strategy === 'volume') {
    if (volMult >= ap.volMult) score += 25;
    if (macd.hist > 0) score += 15;
    if (rsi < (ap.rsiMax || 70)) score += 10;
  } else if (strategy === 'momentum') {
    if (macd.hist > 0 && macd.macd > 0) score += 20;
    if (rsi > 50 && rsi < 70) score += 15;
    if (volMult >= ap.volMult) score += 10;
    if (boll.pct > 0.5) score += 8;
  } else if (strategy === 'mean_reversion') {
    if (rsi < (ap.rsiMax || 30)) score += 25;
    if (boll.pct < 0.2) score += 20; // 밴드 하단 근처
    if (macd.hist > 0) score += 10; // 반등 시작 신호
  }

  // 적응 모드 보정
  score += (ap.scoreBonus || 0);
  return { score: Math.min(100, Math.max(0, Math.round(score))), rsi, macd, boll, volMult, buyPr };
}

// ============================================================
// ── 켈리 공식 기반 자금관리 (Kelly Criterion)
// ============================================================

/**
 * 켈리 공식으로 최적 포지션 크기 계산
 * f* = (bp - q) / b
 *   b = 평균 손익비 (win/loss)
 *   p = 승률
 *   q = 1 - p (패율)
 *
 * 하프켈리 사용 (리스크 절반): f* × 0.5
 * 최소 posMinAmt, 최대 posMaxAmt × posCapMult 제한
 *
 * @param {number} winRate    0~1 (최근 승률)
 * @param {number} avgWin     평균 승리금액 (원)
 * @param {number} avgLoss    평균 손실금액 (원, 양수)
 * @param {number} available  가용 자금 (원)
 * @param {object} cfg        STATE.config
 * @returns {number} 포지션 금액 (원)
 */
function calcKellyPositionSize(winRate, avgWin, avgLoss, available, cfg) {
  const posMin     = cfg.posMinAmt  || 50000;
  const posMaxBase = cfg.posMaxAmt  || 150000;
  const posCapMult = cfg.posCapMult || 1.0;
  const posMax     = Math.round(posMaxBase * posCapMult / 10000) * 10000;

  // 최근 거래 데이터 불충분(< 5회) → 기본 중간값 사용
  const totalTrades = STATE.stats.totalTrades;
  if (totalTrades < 5 || winRate <= 0 || avgLoss <= 0) {
    // 초기: 포지션 금액 = (posMin + posMax) / 2
    const base = Math.round((posMin + posMax) / 2);
    return Math.min(base, available, posMax);
  }

  const p = Math.min(Math.max(winRate, 0.01), 0.99);
  const q = 1 - p;
  // 손익비: avgWin / avgLoss
  const b = avgLoss > 0 ? avgWin / avgLoss : 1;

  // 켈리 비율 (음수면 0 처리)
  let kellyFrac = (b * p - q) / b;
  kellyFrac = Math.max(0, kellyFrac);

  // 하프 켈리 (리스크 절반)
  const halfKelly = kellyFrac * 0.5;

  // 연속 손실 시 포지션 축소 (마틴게일 역방향 — 안티마틴게일)
  const drawdownFactor = calcDrawdownFactor();

  // 포지션 금액 = 가용 자금 × 하프켈리 × 드로우다운 조정
  const raw = Math.round(available * halfKelly * drawdownFactor);

  // 최소/최대 제한
  const capped = Math.min(Math.max(raw, posMin), posMax, available);
  return capped;
}

/**
 * 연속 손실에 따른 포지션 축소 계수 반환
 * 연속 손실 0회: 1.0 (100%)
 * 연속 손실 1회: 0.8 (80%)
 * 연속 손실 2회: 0.6 (60%)
 * 연속 손실 3회+: 0.4 (40%)
 */
function calcDrawdownFactor() {
  const results = STATE.recentResults;
  if (results.length === 0) return 1.0;
  // 최근 결과에서 연속 손실 횟수 카운트 (뒤에서부터)
  let consecutive = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (!results[i].win) consecutive++;
    else break;
  }
  if (consecutive === 0) return 1.0;
  if (consecutive === 1) return 0.8;
  if (consecutive === 2) return 0.6;
  return 0.4; // 3회 이상 연속 손실
}

/**
 * 평균 승리/손실 금액 계산 (최근 20회 기준)
 */
function calcAvgWinLoss() {
  const results = STATE.recentResults.slice(-20);
  const wins    = results.filter(r => r.win);
  const losses  = results.filter(r => !r.win);
  const avgWin  = wins.length   > 0 ? wins.reduce((s, r) => s + Math.abs(r.pnlPct), 0) / wins.length   : STATE.config.profitTarget;
  const avgLoss = losses.length > 0 ? losses.reduce((s, r) => s + Math.abs(r.pnlPct), 0) / losses.length : STATE.config.stopLoss;
  return { avgWin, avgLoss };
}

// ─── 단일 탭 리더 선출 (BroadcastChannel 기반) ────────────────
// 여러 기기/탭에서 동시에 봇을 실행하면 주문이 중복되므로
// 새 탭이 "봇 시작"하면 기존 탭의 봇은 자동 정지됨
const BOT_CHANNEL_NAME = 'stockbot_leader';
let _botChannel = null;
let _botTabId = Math.random().toString(36).slice(2); // 이 탭의 고유 ID

function initBotChannel() {
  try {
    _botChannel = new BroadcastChannel(BOT_CHANNEL_NAME);
    _botChannel.onmessage = (e) => {
      // 다른 탭이 봇을 시작했으면 → 이 탭의 봇 강제 정지
      if (e.data?.type === 'BOT_STARTED' && e.data?.tabId !== _botTabId) {
        if (STATE.running) {
          addLog('warn', `⚠️ 다른 기기/탭에서 봇이 시작됨 → 이 탭 봇 자동 정지`);
          stopBot();
        }
      }
    };
  } catch(e) {
    // BroadcastChannel 미지원 환경 (구형 브라우저) → 무시
    _botChannel = null;
  }
}
function notifyBotStarted() {
  if (_botChannel) {
    _botChannel.postMessage({ type: 'BOT_STARTED', tabId: _botTabId, ts: Date.now() });
  }
}

// ─── 전역 상태 ───────────────────────────────────────────────
const STATE = {
  running: false,
  mode: 'paper',           // 'paper' | 'live'
  market: 'KR',           // 'KR'=국내 | 'US'=미국 | 'BOTH'=국내+미국 동시
  strategy: 'scalping',
  positions: [],           // [{ticker, name, entryPrice, qty, entryTime, currentPrice, pnlPct, market}]
  _pendingTickers: new Set(), // 주문 진행 중 ticker 잠금 (중복 매수 방지)
  stats: { totalTrades: 0, winTrades: 0, totalProfit: 0, dailyProfit: 0 },
  config: {
    maxPositions: 3,
    positionSizeRatio: 0.30,
    profitTarget: 1.5,
    stopLoss: 1.0,
    scanInterval: 30,
    paperCapital: 5000000,
    posMinAmt: 50000,
    posMaxAmt: 150000,
    posCapMult: 1.0,
    // 미국주식 전용
    usRatio: 0.5,          // BOTH 모드에서 미국주식 자본 비중 (0.0~1.0)
  },
  paperBalance: 5000000,   // 페이퍼 가용 현금 (원화)
  paperBalanceUsd: 0,      // 페이퍼 달러 잔고 (BOTH/US 모드)
  scanTimer: null,
  nextScanIn: 0,
  countdownTimer: null,
  profitHistory: [],
  candidates: [],
  adaptiveMode: 1,
  recentResults: [],
  // ── 실전 잔고 캐시 ─────────────────────────────────────
  liveBalance: 0,
  liveBalanceTs: 0,
  liveBalanceFetching: false,
  // ── 미국주식 잔고 캐시 ─────────────────────────────────
  liveBalanceUsd: 0,       // 달러 현금 잔고
  liveBalanceKrwForUs: 0,  // 통합증거금 원화 가용금액 (환전 없이 해외주식 매수 가능)
  liveTotalAsset: 0,       // KIS API 총평가금액 (현금+주식, 이중계산 방지)
  liveBalanceUsdTs: 0,
  liveBalanceUsdFetching: false,
  _balWarnedOnce: false,       // 잔고 부족 경고 중복 방지 플래그
  // ── 환율 캐시 ──────────────────────────────────────────
  usdKrw: 1380,            // 원/달러 환율 (기본값)
  usdKrwTs: 0,             // 환율 마지막 조회
  // ── 장 마감 청산 플래그 ────────────────────────────────
  krPreCloseSent:   false,   // 국내 장마감 1시간 전 (14:30) 청산 시작 여부
  krCloseAlertSent: false,   // 국내 장마감 30분 전 (15:00) 신규매수 차단 여부
  usCloseAlertSent: false,   // 미국 장마감 30분 전 청산 알림 발송 여부
  // ── 내부 플래그 ────────────────────────────────────────
  _lastMarketClosedLog: 0,
  _krWasOpen: false,         // 텔레그램 마감 리포트: 국내 장 직전 상태
  _usWasOpen: false,         // 텔레그램 마감 리포트: 미국 장 직전 상태
};

// API 키 (로컬 스토리지 — 새로고침/탭 닫아도 유지)
const KEYS = {
  get appKey()    { return localStorage.getItem('kis_app_key') || '' },
  get appSecret() { return localStorage.getItem('kis_app_secret') || '' },
  get accountNo() { return localStorage.getItem('kis_account_no') || '' },
  save(k, s, a) {
    localStorage.setItem('kis_app_key',    k);
    localStorage.setItem('kis_app_secret', s);
    localStorage.setItem('kis_account_no', a);
  }
};

// API 공통 헤더
function apiHeaders() {
  return {
    'x-app-key':    KEYS.appKey,
    'x-app-secret': KEYS.appSecret,
    'x-account-no': KEYS.accountNo,
  };
}

// ─── 초기화 ───────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  initBotChannel();       // 단일 탭 리더 채널 초기화 (다른 탭/기기 봇 시작 시 이 탭 자동 정지)
  loadSavedKeys();
  loadConfig();           // 저장된 범위 복원 or 기본값 자동 계산 포함
  loadTelegramKeys();     // 텔레그램 설정 UI 복원
  renderStrategyConditions();
  updateMarketStatus();
  await loadTradeHistory();
  initProfitChart();

  // ── 수동 입력 원화 잔고 즉시 STATE 복원 (서버 차단 환경 대응) ──
  const _savedManualBal = parseInt(localStorage.getItem('manual_krw_balance') || '0');
  if (_savedManualBal > 0) {
    STATE.liveBalance        = _savedManualBal;
    STATE.liveBalanceTs      = Date.now();
    STATE.liveBalanceKrwForUs = _savedManualBal;
    // 이 시점에서는 로그 패널이 아직 준비됐을 수도 있음 — setTimeout으로 안전하게 출력
    setTimeout(() => addLog('info', `💰 수동 잔고 복원: ${fmtPrice(_savedManualBal)}원 (통합증거금 — 매수 즉시 사용 가능)`), 200);
  }

  // 저장된 모드 복원 (localStorage에서 읽기)
  const savedMode = localStorage.getItem('bot_mode') || 'paper';
  STATE.mode = savedMode;
  document.getElementById('mode-paper').classList.toggle('active-mode', savedMode === 'paper');
  document.getElementById('mode-live').classList.toggle('active-mode', savedMode === 'live');
  document.getElementById('mode-live').classList.toggle('danger', savedMode === 'live');

  updateStatsUI();
  renderPosSlots();
  updateAdaptiveBadge();

  // ── 포지션 복원 (새로고침 후 보유 포지션 유지) ──
  await loadPositions();

  const logMsg = KEYS.appKey
    ? `📈 StockBot 초기화 완료. API 키 확인됨 (${KEYS.appKey.slice(0,4)}...)`
    : '📈 StockBot 초기화 완료. API 키를 설정하세요.';
  addLog('info', logMsg);

  // 실전 모드로 복원된 경우 잔고 자동 조회
  if (savedMode === 'live' && KEYS.appKey && KEYS.accountNo) {
    addLog('info', '🔄 실전 모드 복원 — 잔고 자동 조회 중...');
    STATE.liveBalanceFetching = true;
    updateStatsUI();
    getLiveBalance().then(result => {
      const bal = result?.balance ?? result ?? 0;
      STATE.liveBalanceFetching = false;
      if (bal > 0) {
        // 실제 잔고 수신 시에만 덮어씀 (0이면 수동 입력값 유지)
        STATE.liveBalance        = bal;
        STATE.liveBalanceTs      = Date.now();
        STATE.liveBalanceKrwForUs = bal;
        addLog('info', `💰 잔고 복원: ${fmtPrice(bal)}원 (통합증거금 — 미국주식 가용)`);
      } else {
        // serverBlocked 등으로 0 반환 → 수동 입력값이 있으면 유지
        STATE.liveBalanceTs = Date.now();
        const manual = parseInt(localStorage.getItem('manual_krw_balance') || '0');
        if (manual > 0 && STATE.liveBalance === 0) {
          STATE.liveBalance        = manual;
          STATE.liveBalanceKrwForUs = manual;
        }
      }
      updateStatsUI();
    }).catch(() => {
      STATE.liveBalanceFetching = false;
      STATE.liveBalanceTs = Date.now();
      updateStatsUI();
    });
    // 환율 사전 조회
    if (STATE.market !== 'KR') fetchUsdKrw();
    // US/BOTH 모드 달러 잔고 조회
    // BOTH 모드: KR 조회와 동시 토큰 발급 방지 → 15초 딜레이 후 US 조회
    if (STATE.market === 'US') {
      triggerUsdBalanceFetch();
    } else if (STATE.market === 'BOTH') {
      addLog('info', '⏳ BOTH 모드 — 미국 잔고는 국내 조회 후 15초 뒤 조회합니다');
      setTimeout(() => triggerUsdBalanceFetch(), 15000);
    }
  }

  // 주기적 UI 갱신: 포지션 가격 + 총자산 카드
  setInterval(tickPositions, 5000);
  setInterval(updateMarketStatus, 60000);
  // 총자산 숫자 애니메이션용 1초 갱신
  setInterval(updateStatsUI, 1000);
});

// ─── API 설정 모달 ────────────────────────────────────────────
function openApiSettings()  { document.getElementById('api-modal').classList.remove('hidden'); }
function closeApiSettings() { document.getElementById('api-modal').classList.add('hidden'); }

// ── 원화 잔고 직접 입력 (서버 차단 환경 대응)
function openBalanceInput() {
  const row = document.getElementById('manual-balance-row');
  if (!row) return;
  const saved = parseInt(localStorage.getItem('manual_krw_balance') || '0');
  if (saved > 0) document.getElementById('manual-balance-input').value = saved;
  row.classList.remove('hidden');
  setTimeout(() => document.getElementById('manual-balance-input')?.focus(), 50);
}
function closeBalanceInput() {
  document.getElementById('manual-balance-row')?.classList.add('hidden');
}
function applyManualBalance() {
  const val = parseInt(document.getElementById('manual-balance-input').value || '0');
  if (!val || val < 1000) { alert('1,000원 이상의 금액을 입력하세요'); return; }
  localStorage.setItem('manual_krw_balance', String(val));
  STATE.liveBalance        = val;
  STATE.liveBalanceTs      = Date.now();
  STATE.liveBalanceKrwForUs = val;
  addLog('info', `💰 원화 잔고 수동 입력: ${fmtPrice(val)}원 — 매수에 즉시 사용됩니다`);
  closeBalanceInput();
  updateStatsUI();
}

/** 통합증거금 원화 잔고 수동 적용 */
function applyManualKrwBalance() {
  const raw = parseInt(document.getElementById('input-krw-balance').value || '0');
  if (isNaN(raw) || raw < 0) {
    alert('올바른 금액을 입력하세요 (0 이상의 정수)');
    return;
  }
  STATE.liveBalanceKrwForUs = raw;
  STATE.liveBalanceUsdTs = Date.now(); // "미조회 상태" 탈출
  localStorage.setItem('manual_krw_balance', String(raw));
  const disp = document.getElementById('krw-balance-display');
  if (raw > 0) {
    disp.textContent = `✅ 적용됨: ${fmtPrice(raw)}원 — 미국주식 매수 가능`;
    disp.classList.remove('hidden');
    addLog('info', `💴 통합증거금 원화 잔고 수동 설정: ${fmtPrice(raw)}원 (미국주식 매수 가능)`);
  } else {
    disp.textContent = '수동 잔고 초기화됨';
    disp.classList.remove('hidden');
    addLog('info', '💴 통합증거금 수동 잔고 초기화');
  }
  updateStatsUI();
}

function loadSavedKeys() {
  document.getElementById('input-app-key').value    = KEYS.appKey    ? '●●●●●●●●' : '';
  document.getElementById('input-app-secret').value = KEYS.appSecret ? '●●●●●●●●' : '';
  document.getElementById('input-account-no').value = KEYS.accountNo || '';
  // 수동 입력 원화 잔고 복원
  const savedKrw = parseInt(localStorage.getItem('manual_krw_balance') || '0');
  if (savedKrw > 0) {
    document.getElementById('input-krw-balance').value = savedKrw;
    STATE.liveBalanceKrwForUs = savedKrw;
    const disp = document.getElementById('krw-balance-display');
    disp.textContent = `✅ 적용됨: ${fmtPrice(savedKrw)}원`;
    disp.classList.remove('hidden');
  }
}

function saveApiKeys() {
  let k = document.getElementById('input-app-key').value.trim();
  let s = document.getElementById('input-app-secret').value.trim();
  const a = document.getElementById('input-account-no').value.trim();

  // 마스킹 값(●)이면 기존 저장 키를 유지 (계좌번호만 바꿀 때 KEY 재입력 불필요)
  const isMasked = (v) => !v || /^●+$/.test(v);
  if (isMasked(k)) k = KEYS.appKey;
  if (isMasked(s)) s = KEYS.appSecret;

  // 공백/탭/개행 완전 제거 (복붙 시 보이지 않는 공백 포함)
  k = k.replace(/\s/g, '');
  s = s.replace(/\s/g, '');

  if (!k) { showApiResult('⚠️ APP KEY를 입력하세요', 'warn'); return; }
  if (!s) { showApiResult('⚠️ APP SECRET를 입력하세요', 'warn'); return; }

  // 키 형식 기본 검증 (KIS APP KEY는 보통 36자)
  if (k.length < 10) { showApiResult('⚠️ APP KEY가 너무 짧습니다 (복사 오류 확인)', 'warn'); return; }
  if (s.length < 10) { showApiResult('⚠️ APP SECRET가 너무 짧습니다 (복사 오류 확인)', 'warn'); return; }

  KEYS.save(k, s, a);
  showApiResult(`✅ 저장 완료 — KEY: ${k.slice(0,4)}...${k.slice(-4)} (${k.length}자) | 계좌: ${a || '미입력'}`, 'ok');
  addLog('info', `🔑 API 키 저장 완료 — APP KEY ${k.slice(0,4)}...${k.slice(-4)} (${k.length}자) | 계좌 ${a || '없음'}`);

  // 계좌번호가 있으면 실전/페이퍼 무관하게 즉시 잔고 조회
  // (계좌 변경 여부 확인 + 실전 모드 전환 시 즉시 반영)
  if (a) {
    setTimeout(() => {
      STATE.liveBalanceTs = 0;
      STATE.liveBalanceFetching = true;
      updateStatsUI();
      getLiveBalance().then(bal => {
        STATE.liveBalance = bal;
        STATE.liveBalanceTs = Date.now();
        STATE.liveBalanceFetching = false;
        if (bal > 0) STATE.liveBalanceKrwForUs = bal; // 통합증거금 자동 동기화
        if (bal > 0) addLog('info', `💰 잔고 확인: ${fmtPrice(bal)}원 (통합증거금 — 미국주식 가용)`);
        else addLog('info', '💰 잔고 조회 완료 (주문 가능 현금 없음)');
        updateStatsUI();
      }).catch(() => {
        STATE.liveBalanceFetching = false;
        STATE.liveBalanceTs = Date.now();
        updateStatsUI();
      });
      // US/BOTH 모드면 달러 잔고도 갱신 (BOTH는 KR 완료 후 15초 대기)
      if (STATE.market === 'US') {
        setTimeout(() => { STATE.liveBalanceUsdTs = 0; triggerUsdBalanceFetch(); }, 900);
      } else if (STATE.market === 'BOTH') {
        setTimeout(() => { STATE.liveBalanceUsdTs = 0; triggerUsdBalanceFetch(); }, 15000);
      }
    }, 900); // 모달 닫힌 후 조회
  }
  setTimeout(closeApiSettings, 800);
}

/**
 * KIS 토큰 발급 — 서버 프록시(/api/kis/token) 경유
 * ✅ 실제 access_token을 localStorage에 캐싱 (22.5시간 TTL)
 *    → 모든 KIS API 요청에 kisToken으로 포함해서 서버 Rate Limit 완전 방지
 */
async function kisGetTokenViaProxy(appKey, appSecret) {
  const cached = localStorage.getItem('kis_token_cached');
  const exp    = parseInt(localStorage.getItem('kis_token_exp') || '0');
  // 캐시된 토큰이 있고 만료 전이면 바로 반환
  if (cached && cached !== 'proxy_ok' && cached.length > 50 && Date.now() < exp) return cached;

  const res = await fetch('/api/kis/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey, appSecret }),
  });
  const data = await res.json();
  if (!res.ok || data.serverBlocked) {
    throw Object.assign(new Error(data.error || '서버 프록시 차단'), { serverBlocked: true });
  }
  // ✅ 실제 access_token을 localStorage에 캐싱 (22.5시간 TTL)
  if (data.accessToken && data.accessToken.length > 50) {
    localStorage.setItem('kis_token_cached', data.accessToken);
    localStorage.setItem('kis_token_exp', String(Date.now() + 82800 * 1000));
    return data.accessToken;
  }
  // 토큰 반환이 없으면 proxy_ok 표시만 (하위 호환)
  localStorage.setItem('kis_token_cached', 'proxy_ok');
  localStorage.setItem('kis_token_exp', String(Date.now() + 82800 * 1000));
  return 'proxy_ok';
}

/** KIS 토큰 반환 — 서버 프록시 경유 (캐시 포함) */
async function getKisToken() {
  return await kisGetTokenViaProxy(KEYS.appKey, KEYS.appSecret);
}

/** 현재 캐시된 KIS 토큰 반환 (발급 없이) — API 요청 body에 포함용 */
function getCachedKisToken() {
  const t = localStorage.getItem('kis_token_cached');
  const exp = parseInt(localStorage.getItem('kis_token_exp') || '0');
  if (t && t !== 'proxy_ok' && t.length > 50 && Date.now() < exp) return t;
  return null;
}

async function testApiConnection() {
  showApiResult('🔄 서버 프록시로 KIS 연결 테스트 중...', 'info');
  let k = document.getElementById('input-app-key').value.trim();
  let s = document.getElementById('input-app-secret').value.trim();

  // 마스킹 값(●)이면 localStorage의 실제 저장 키를 사용
  // — 모달 재오픈 시 항상 ●●●●●●●●로 표시되므로 saved key로 폴백
  const isMasked = (v) => !v || /^●+$/.test(v);
  if (isMasked(k)) k = KEYS.appKey;
  if (isMasked(s)) s = KEYS.appSecret;

  // 공백/탭/개행 완전 제거
  k = k.replace(/\s/g, '');
  s = s.replace(/\s/g, '');

  if (!k || !s) {
    showApiResult('⚠️ APP KEY와 APP SECRET를 먼저 입력 후 저장하세요', 'warn'); return;
  }

  // 진단 로그: 어떤 키로 테스트하는지 출력
  addLog('info', `🔍 테스트 키: ${k.slice(0,4)}...${k.slice(-4)} (${k.length}자) / SECRET: ...${s.slice(-4)} (${s.length}자)`);

  // ── 1단계: KIS 현재가 테스트 (삼성전자 005930) — API 키 있을 때
  try {
    const nr = await fetch('/api/kis/kr/price', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: k, appSecret: s, code: '005930' }),
    });
    const nd = await nr.json();
    if (nd.ok && nd.price > 0) {
      addLog('info', `📊 KIS 현재가 연동 ✅ — ${nd.name||'삼성전자'} ${(nd.price||0).toLocaleString()}원 [KIS 실시간]`);
    } else {
      // KIS 실패 → 네이버 폴백 확인
      const fb = await axios.get('/api/naver/price/005930', { timeout: 5000 });
      if (fb.data?.ok) addLog('info', `📊 네이버 시세 연동 ✅ — 삼성전자 ${(fb.data.price||0).toLocaleString()}원 [네이버 폴백]`);
    }
  } catch(e) {
    addLog('warn', '⚠️ 현재가 조회 실패: ' + (e.message||''));
  }

  // ── 2단계: 서버 프록시 → KIS 연결 테스트 ──
  try {
    const res = await fetch('/api/kis/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: k, appSecret: s }),
    });
    const data = await res.json();

    if (data.ok) {
      // ✅ 토큰 발급 성공 — 실제 access_token을 localStorage에 캐싱
      if (data.accessToken && data.accessToken.length > 50) {
        localStorage.setItem('kis_token_cached', data.accessToken);
      } else {
        localStorage.setItem('kis_token_cached', 'proxy_ok');
      }
      localStorage.setItem('kis_token_exp', String(Date.now() + 82800 * 1000));
      showApiResult('✅ KIS 연결 성공! 저장 버튼을 눌러 키를 저장하세요', 'ok');
      addLog('info', '✅ KIS 연결 성공 — 서버 프록시 모드 (실전 모드 사용 가능)');

      // 계좌번호 있으면 실전/페이퍼 무관하게 즉시 잔고 조회 (계좌 유효성 확인 + UI 갱신)
      const aInput = document.getElementById('input-account-no').value.trim();
      const a = aInput || KEYS.accountNo; // 빈칸이면 저장된 계좌번호 폴백
      if (a) {
        // 현재 입력된 키/계좌로 즉시 조회 (저장 여부와 무관)
        setTimeout(async () => {
          STATE.liveBalanceTs = 0;
          STATE.liveBalanceFetching = true;
          updateStatsUI();
          try {
            const balRes = await fetch('/api/kis/balance', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ appKey: k, appSecret: s, accountNo: a }),
            });
            const balData = await balRes.json();
            if (balData.ok && typeof balData.balance === 'number') {
              STATE.liveBalance = balData.balance;
              STATE.liveBalanceTs = Date.now();
              if (balData.balance > 0) STATE.liveBalanceKrwForUs = balData.balance; // 통합증거금 자동 동기화
              if (balData.balance > 0) addLog('info', `💰 실전 잔고: ${fmtPrice(balData.balance)}원 (통합증거금 — 미국주식 가용)`);
              else addLog('info', '💰 잔고 조회 완료 (주문 가능 현금 없음)');
            } else {
              STATE.liveBalanceTs = Date.now();
              if (balData.error) addLog('warn', `⚠️ 잔고 조회 실패: ${balData.error}`);
            }
          } catch {
            STATE.liveBalanceTs = Date.now();
          } finally {
            STATE.liveBalanceFetching = false;
            updateStatsUI();
          }
        }, 300);
      }
    } else if (data.kisReachable) {
      // ⚠️ KIS 서버에는 연결됐으나 키 인증 실패 (잘못된 키)
      showApiResult('⚠️ KIS 서버 연결 OK — 키 인증 실패. APP KEY/SECRET을 확인하세요', 'warn');
      addLog('warn', '⚠️ KIS 서버 연결 성공, 하지만 인증 실패');
      addLog('warn', `   오류: ${data.error || ''}`);
      // 진단: 실제 사용된 키 앞 4자리 표시 (키가 맞는지 확인용)
      addLog('info', `🔍 진단 — 사용된 APP KEY: ${k.slice(0, 4)}...${k.slice(-4)} (총 ${k.length}자)`);
      addLog('info', `🔍 진단 — localStorage 저장 키: ${KEYS.appKey ? KEYS.appKey.slice(0,4) + '...' + KEYS.appKey.slice(-4) + ' (' + KEYS.appKey.length + '자)' : '없음'}`);
      addLog('info', '💡 해결 방법:');
      addLog('info', '   1. API 설정 열기 → APP KEY/SECRET 직접 다시 입력 → 저장');
      addLog('info', '   2. KIS Developers(apiportal.koreainvestment.com) → 앱 관리 → 키 확인');
      addLog('info', '   3. 모의투자 키 vs 실전투자 키 혼용 여부 확인');
    } else if (data.serverBlocked) {
      // ⛔ 서버→KIS 네트워크 연결 자체가 안 됨
      showApiResult('⚠️ 서버→KIS 네트워크 차단 — 아래 안내를 확인하세요', 'warn');
      addLog('warn', '⚠️ 서버→KIS 네트워크 연결 실패');
      addLog('info', '📄 페이퍼 모드: 지금 바로 사용 가능합니다');
      addLog('info', '🌐 실전 모드: 재배포 후 재시도 권장');
      showLiveModeBanner();
    } else {
      showApiResult('❌ KIS 오류: ' + (data.error || '알 수 없는 오류').slice(0, 80), 'error');
      addLog('error', '❌ KIS 오류: ' + (data.error || ''));
    }
  } catch(e) {
    const msg = e.message || String(e);
    showApiResult('❌ 서버 오류: ' + msg.slice(0, 60), 'error');
    addLog('error', '❌ 연결 테스트 실패: ' + msg);
  }
}

/** 실전 모드 제약 안내 배너를 모달에 표시 */
function showLiveModeBanner() {
  let banner = document.getElementById('live-mode-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'live-mode-banner';
    banner.className = 'bg-yellow-950/60 border border-yellow-700 rounded p-3 text-xs text-yellow-300 space-y-1.5';
    const modal = document.querySelector('#api-modal .space-y-4');
    if (modal) modal.appendChild(banner);
  }
  banner.innerHTML = `
    <p class="font-semibold text-yellow-200"><i class="fas fa-exclamation-triangle mr-1"></i>실전 모드 이용 안내</p>
    <p>• <strong>KIS API는 서버 전용</strong> — 브라우저 직접 호출이 불가합니다 (CORS 정책)</p>
    <p>• <strong>현재 환경</strong>: 로컬 샌드박스 서버 → KIS 연결이 차단되어 있습니다</p>
    <p class="pt-1 border-t border-yellow-800">✅ <strong>페이퍼 모드</strong>: 지금 바로 사용 가능 (시뮬레이션)</p>
    <p>🌐 <strong>실전 모드</strong>: Cloudflare Pages 배포 후 서버 프록시로 이용 가능</p>
  `;
}

function showApiResult(msg, type) {
  const el = document.getElementById('api-test-result');
  el.textContent = msg;
  el.className = 'text-xs text-center ' + {
    ok: 'text-green-400', warn: 'text-yellow-400', error: 'text-red-400', info: 'text-blue-400'
  }[type];
}

// ─── 모드 / 전략 설정 ─────────────────────────────────────────
function setMode(mode) {
  STATE.mode = mode;
  localStorage.setItem('bot_mode', mode);  // 모드 영구 저장
  document.getElementById('mode-paper').classList.toggle('active-mode', mode === 'paper');
  document.getElementById('mode-live').classList.toggle('active-mode', mode === 'live');
  document.getElementById('mode-live').classList.toggle('danger', mode === 'live');
  if (mode === 'live') {
    if (!KEYS.appKey) {
      addLog('warn', '⚠️ 실전 모드: API 키를 먼저 설정하세요');
      openApiSettings();
    } else {
      addLog('warn', '🔴 실전 모드 활성화');
      addLog('info', '   ∙ 시세 조회: 네이버 금융 프록시 (정상)');
      addLog('info', '   ∙ 주문 실행: 서버 프록시(/api/kis/order) 경유');
      addLog('info', '   ⚠️ 로컬 환경에서는 주문이 차단될 수 있습니다 — 연결 테스트 먼저 권장');
      // ── 실전 전환 즉시 잔고 조회 시작 ─────────────────
      STATE.liveBalanceTs = 0;    // 조회 미완료 상태로 초기화
      STATE.liveBalanceUsdTs = 0;
      // 즉시 UI를 "조회 중" 상태로 갱신
      updateStatsUI();
      if (KEYS.accountNo && !STATE.liveBalanceFetching) {
        STATE.liveBalanceFetching = true;
        updateStatsUI(); // fetching=true 즉시 반영
        getLiveBalance().then(result => {
          const bal = result?.balance ?? result ?? 0;
          STATE.liveBalance    = bal;
          STATE.liveBalanceTs  = Date.now();
          STATE.liveBalanceFetching = false;
          if (bal > 0) STATE.liveBalanceKrwForUs = bal; // 통합증거금 자동 동기화
          if (bal > 0) addLog('info', `💰 실전 잔고 확인: ${fmtPrice(bal)}원 (통합증거금 — 미국주식 가용)`);
          else addLog('info', '💰 잔고 조회 완료 (주문 가능 현금 없음 — KIS 앱 확인 권장)');
          updateStatsUI();
        }).catch((e) => {
          STATE.liveBalanceFetching = false;
          STATE.liveBalanceTs = Date.now(); // 실패도 "조회 완료"로 표시
          addLog('warn', '⚠️ 잔고 조회 실패: ' + (e?.message || '네트워크 오류'));
          updateStatsUI();
        });
      } else if (!KEYS.accountNo) {
        addLog('warn', '⚠️ 계좌번호를 설정하세요 (API 설정에서 계좌번호 입력)');
        // 계좌번호 없으면 "조회 불가" 상태 — "계좌 연결 필요" 대신 "계좌번호 필요" 표시
        STATE.liveBalanceTs = 0;  // 조회 미완료 유지 (계좌번호 없음 표시용)
        updateStatsUI();
      }
      // 미국 모드면 달러 잔고도 조회 (BOTH는 KR 완료 후 15초 대기)
      if (STATE.market === 'US') {
        triggerUsdBalanceFetch();
      } else if (STATE.market === 'BOTH') {
        setTimeout(() => triggerUsdBalanceFetch(), 15000);
      }
    }
  } else {
    STATE.liveBalance = 0;
    STATE.liveBalanceTs = 0;
    STATE.liveBalanceUsd = 0;
    STATE.liveBalanceUsdTs = 0;
  }
  // 모드 전환 시 해당 모드의 저장된 포지션으로 교체
  const posKey = mode === 'live' ? 'live_positions' : 'paper_positions';
  try {
    const raw = localStorage.getItem(posKey);
    STATE.positions = raw ? JSON.parse(raw) : [];
  } catch { STATE.positions = []; }
  renderPositions();
  renderStrategyConditions();
}

// ─── 시장 선택 (국내 / 미국 / 국내+미국) ─────────────────────
function setMarket(market) {
  STATE.market = market; // 'KR' | 'US' | 'BOTH'
  localStorage.setItem('bot_market', market);

  // 버튼 활성 상태 업데이트
  ['KR', 'US', 'BOTH'].forEach(m => {
    const el = document.getElementById('market-' + m);
    if (el) el.classList.toggle('active-market', m === market);
  });

  // 시장별 안내 로그
  if (market === 'KR') {
    addLog('info', '🇰🇷 국내주식 모드 — 코스피/코스닥 정규장 (09:00~15:30)');
    // 미국 잔고 캐시 초기화
    STATE.liveBalanceUsd = 0;
    STATE.liveBalanceUsdTs = 0;
    STATE.liveBalanceKrwForUs = 0;
  } else if (market === 'US') {
    addLog('info', '🇺🇸 미국주식 모드 — 야간 정규장 (23:30~06:00 KST)');
    addLog('info', '   ∙ 지정가 주문만 지원 (KIS API 제약)');
    addLog('info', '   ∙ 달러 지정가로 주문, 잔고는 달러 표시');
    // 미국 잔고 즉시 조회
    if (STATE.mode === 'live') triggerUsdBalanceFetch();
    // 페이퍼 모드에서 US로 전환 시 달러 잔고 초기화
    if (STATE.mode === 'paper' && STATE.config.paperCapital > 0) {
      STATE.paperBalanceUsd = STATE.config.paperCapital / STATE.usdKrw;
      STATE.paperBalance = 0;
      addLog('info', `💵 페이퍼 달러 잔고 초기화: $${STATE.paperBalanceUsd.toFixed(2)}`);
    }
  } else if (market === 'BOTH') {
    addLog('info', '🌏 국내+미국 동시 모드 (국내/미국 각 100% 독립 — 시간대 분리)');
    if (STATE.mode === 'live') triggerUsdBalanceFetch();
    // 페이퍼 모드에서 BOTH로 전환 시 달러 잔고 초기화 (각 100%)
    if (STATE.mode === 'paper' && STATE.config.paperCapital > 0) {
      const usdPart = STATE.config.paperCapital; // 미국도 100%
      STATE.paperBalanceUsd = usdPart / STATE.usdKrw;
      STATE.paperBalance = STATE.config.paperCapital; // 국내도 100%
      addLog('info', `💵 페이퍼 자본: 국내 ${fmtManwon(STATE.paperBalance)} / 미국 $${STATE.paperBalanceUsd.toFixed(2)} (각 100%)`);
    }
  }

  // 환율 패널 표시 여부
  const fxPanel = document.getElementById('fx-panel');
  if (fxPanel) fxPanel.classList.toggle('hidden', market === 'KR');

  // 환율 최신화
  if (market !== 'KR') fetchUsdKrw();

  updateMarketStatus();
  updateStatsUI();
}

function triggerUsdBalanceFetch() {
  // 봇 실행 중이면 스캔 배치 조회에서 잔고도 함께 처리 → 중복 호출 안 함
  if (!KEYS.appKey || !KEYS.accountNo || STATE.liveBalanceUsdFetching || STATE.running) return;
  STATE.liveBalanceUsdFetching = true;
  // 잔고만 조회 (symbols=[] 빈 배열, accountNo 전달) → 토큰 1회 발급
  fetch('/api/kis/us/prices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appKey: KEYS.appKey, appSecret: KEYS.appSecret,
      symbols: [{ ticker: 'AAPL', excd: 'NAS' }], // 최소 1개 필요 (빈 배열 에러 방지)
      accountNo: KEYS.accountNo,
    }),
    signal: AbortSignal.timeout(15000),
  }).then(r => r.json()).then(data => {
    STATE.liveBalanceUsdFetching = false;
    if (data.balance && data.balance.cashUsd >= 0) {
      STATE.liveBalanceUsd    = data.balance.cashUsd;
      STATE.liveBalanceUsdTs  = Date.now();
      if (data.balance.cashKrw > 0) STATE.liveBalanceKrwForUs = data.balance.cashKrw;
      if (data.balance.cashUsd > 0) {
        addLog('info', `💵 미국주식 달러 잔고: $${data.balance.cashUsd.toFixed(2)} (≈${fmtPrice(Math.round(data.balance.cashUsd * STATE.usdKrw))}원)`);
      } else if (data.balance.cashKrw > 0) {
        addLog('info', `💴 통합증거금 원화 잔고: ${fmtPrice(data.balance.cashKrw)}원 (환전 없이 해외주식 매수 가능)`);
      }
    } else if (data.error) {
      addLog('warn', `⚠️ 미국주식 잔고 오류: ${data.error}`);
      STATE.liveBalanceUsdTs = Date.now();
    }
    updateStatsUI();
  }).catch(() => {
    STATE.liveBalanceUsdFetching = false;
    STATE.liveBalanceUsdTs = Date.now();
  });
}

function updateSlider(id, labelId, suffix) {
  const val = parseFloat(document.getElementById(id).value);
  document.getElementById(labelId).textContent = val.toFixed(1) + suffix;
  // ─ 슬라이더 변경 즉시 STATE.config 반영 (저장 버튼 없이도 봇에 적용)
  if (id === 'profit-target') {
    STATE.config.profitTarget = val;
    document.getElementById('profit-target-num').value = val;
  } else if (id === 'stop-loss') {
    STATE.config.stopLoss = val;
    document.getElementById('stop-loss-num').value = val;
  } else if (id === 'max-positions') {
    STATE.config.maxPositions = parseInt(val);
    document.getElementById('max-positions-num').value = parseInt(val);
    document.getElementById('maxpos-display').textContent = parseInt(val);
    renderPosSlots();
  }
  autoSaveConfig();
  renderStrategyConditions();
}

function updateCapitalSlider() {
  const val = parseInt(document.getElementById('paper-capital').value);
  document.getElementById('paper-capital-val').textContent = val + '00만원';
  document.getElementById('paper-capital-num').value = val;
  STATE.config.paperCapital = val * 1000000;
  applyDefaultPositionRange(STATE.config.paperCapital, false);
  autoSaveConfig();
}

// 숫자 입력 → 슬라이더 동기화 + STATE 즉시 반영
function syncSliderFromNum(sliderId, numId, labelId, suffix) {
  const num = parseFloat(document.getElementById(numId).value);
  const slider = document.getElementById(sliderId);
  const min = parseFloat(slider.min), max = parseFloat(slider.max);
  const clamped = Math.min(Math.max(num, min), max);
  slider.value = clamped;
  document.getElementById(labelId).textContent = clamped.toFixed(suffix === '개' ? 0 : 1) + suffix;
  // STATE.config 즉시 반영
  if (sliderId === 'profit-target') STATE.config.profitTarget = clamped;
  else if (sliderId === 'stop-loss')  STATE.config.stopLoss    = clamped;
  else if (sliderId === 'max-positions') {
    STATE.config.maxPositions = parseInt(clamped);
    document.getElementById('maxpos-display').textContent = parseInt(clamped);
    renderPosSlots();
  }
  autoSaveConfig();
}

function syncCapitalFromNum() {
  const val = parseInt(document.getElementById('paper-capital-num').value) || 1;
  document.getElementById('paper-capital').value = val;
  document.getElementById('paper-capital-val').textContent = val + '00만원';
  STATE.config.paperCapital = val * 1000000;
  applyDefaultPositionRange(STATE.config.paperCapital, false);
  autoSaveConfig();
}

// ─── 포지션 금액 범위 ─────────────────────────────────────────

/**
 * 자본금에서 기본 min/max 계산
 * 기본 비율: min = 자본금×10%, max = 자본금×30%
 * 500만 → 50만/150만 | 1000만 → 100만/300만
 */
function calcDefaultRange(capital) {
  const minAmt = Math.round(capital * 0.10 / 10000) * 10000;   // 10% 단위 만원
  const maxAmt = Math.round(capital * 0.30 / 10000) * 10000;   // 30% 단위 만원
  return { minAmt, maxAmt };
}

/** 만원 → "X만원" 또는 "X,XXX만원" 표기 */
function fmtManwon(won) {
  const man = Math.round(won / 10000);
  return man.toLocaleString('ko-KR') + '만원';
}

/**
 * 자본금 기준 기본값을 UI에 반영
 * @param {number} capital  적용할 자본금
 * @param {boolean} force   true면 STATE.config까지 덮어씀 (리셋 버튼)
 */
function applyDefaultPositionRange(capital, force) {
  const { minAmt, maxAmt } = calcDefaultRange(capital);

  // 슬라이더 max 동적 조정 (자본금의 100%까지 허용)
  const sliderMax = Math.max(capital, 1000000);
  document.getElementById('pos-min').max = sliderMax;
  document.getElementById('pos-max').max = sliderMax;

  if (force) {
    // 리셋: STATE + UI 모두 기본값으로
    STATE.config.posMinAmt  = minAmt;
    STATE.config.posMaxAmt  = maxAmt;
    STATE.config.posCapMult = 1.0;
    document.getElementById('pos-min').value    = minAmt;
    document.getElementById('pos-max').value    = maxAmt;
    document.getElementById('pos-min-num').value = Math.round(minAmt / 10000);
    document.getElementById('pos-max-num').value = Math.round(maxAmt / 10000);
    document.getElementById('pos-cap').value    = 1.0;
    document.getElementById('pos-cap-val').textContent = '1.0×';
  }

  // 미리보기 텍스트 항상 갱신
  const preEl = document.getElementById('pos-range-preview');
  if (preEl) {
    preEl.textContent =
      `자본금 ${fmtManwon(capital)} 기준 기본값 — 최소 ${fmtManwon(minAmt)} / 최대 ${fmtManwon(maxAmt)}`;
  }

  refreshPosRangeUI();
}

/** 슬라이더/숫자 입력 후 레이블·STATE·최종범위 동기화 */
function refreshPosRangeUI() {
  const minAmt = STATE.config.posMinAmt;
  const maxAmt = STATE.config.posMaxAmt;
  const cap    = STATE.config.posCapMult;
  const finalMax = Math.round(maxAmt * cap / 10000) * 10000;

  document.getElementById('pos-min-val').textContent  = fmtManwon(minAmt);
  document.getElementById('pos-max-val').textContent  = fmtManwon(maxAmt);
  document.getElementById('pos-cap-val').textContent  = cap.toFixed(1) + '×';
  document.getElementById('pos-range-final').textContent =
    `${fmtManwon(minAmt)} ~ ${fmtManwon(finalMax)}`;

  // 최솟값 > 최댓값 경고 표시
  const finalEl = document.getElementById('pos-range-final');
  if (minAmt > maxAmt) {
    finalEl.className = 'text-red-400 font-medium';
    finalEl.textContent = '⚠️ 최솟값이 최댓값보다 큽니다';
  } else {
    finalEl.className = 'text-white font-medium';
  }
}

/** 슬라이더(pos-min / pos-max) 변경 시 */
function onPosRangeChange() {
  const minSlider = parseInt(document.getElementById('pos-min').value);
  const maxSlider = parseInt(document.getElementById('pos-max').value);
  STATE.config.posMinAmt = minSlider;
  STATE.config.posMaxAmt = maxSlider;
  document.getElementById('pos-min-num').value = Math.round(minSlider / 10000);
  document.getElementById('pos-max-num').value = Math.round(maxSlider / 10000);
  refreshPosRangeUI();
  autoSaveConfig();
}

/** 만원 숫자 입력(pos-min-num / pos-max-num) 변경 시 */
function onPosRangeNumChange(which) {
  const numId   = which === 'min' ? 'pos-min-num' : 'pos-max-num';
  const slId    = which === 'min' ? 'pos-min'     : 'pos-max';
  const man     = parseInt(document.getElementById(numId).value) || 1;
  const won     = man * 10000;
  const slMax   = parseInt(document.getElementById(slId).max);
  const clamped = Math.min(Math.max(won, 10000), slMax);
  document.getElementById(slId).value = clamped;
  if (which === 'min') STATE.config.posMinAmt = clamped;
  else                 STATE.config.posMaxAmt = clamped;
  refreshPosRangeUI();
  autoSaveConfig();
}

/** 상한율 슬라이더 변경 시 */
function onPosCapChange() {
  const cap = parseFloat(document.getElementById('pos-cap').value);
  STATE.config.posCapMult = cap;
  refreshPosRangeUI();
  autoSaveConfig();
}

/** 기본값 리셋 버튼 */
function resetPositionRange() {
  applyDefaultPositionRange(STATE.config.paperCapital, true);
  addLog('info', `↩️ 포지션 금액 기본값 복원 — ${fmtManwon(STATE.config.posMinAmt)} ~ ${fmtManwon(STATE.config.posMaxAmt)}`);
}

// 포지션 카드의 +/- 버튼
function changeMaxPos(delta) {
  const cur = STATE.config.maxPositions;
  const next = Math.min(Math.max(cur + delta, 1), 20);
  STATE.config.maxPositions = next;
  document.getElementById('max-positions').value      = next;
  document.getElementById('max-positions-num').value  = next;
  document.getElementById('maxpos-val').textContent   = next + '개';
  document.getElementById('maxpos-display').textContent = next;
  renderPosSlots();
  updateStatsUI();
}

// 포지션 슬롯 시각화 (카드 상단)
function renderPosSlots() {
  const max   = STATE.config.maxPositions;
  const used  = STATE.positions.length;
  const slots = document.getElementById('pos-slots');
  if (!slots) return;
  slots.innerHTML = Array.from({ length: Math.min(max, 20) }).map((_, i) => {
    const filled = i < used;
    return `<span class="w-3 h-3 rounded-sm ${filled ? 'bg-green-500' : 'bg-gray-700'} transition-colors"></span>`;
  }).join('');
}

// maxpos 슬라이더 → 카드 동기화
function syncMaxPosCard() {
  const val = parseInt(document.getElementById('max-positions').value);
  document.getElementById('max-positions-num').value    = val;
  document.getElementById('maxpos-display').textContent = val;
  STATE.config.maxPositions = val;
  renderPosSlots();
  updateStatsUI();
}

function loadConfig() {
  const saved = localStorage.getItem('bot_config');
  if (saved) {
    try {
      const c = JSON.parse(saved);
      Object.assign(STATE.config, c);
    } catch(e) {}
  }
  // ── stats 복원 (Kelly 계산 세션 간 연속성) ─────────────────
  const savedStats = localStorage.getItem('bot_stats');
  if (savedStats) {
    try {
      const s = JSON.parse(savedStats);
      STATE.stats.totalTrades = s.totalTrades || 0;
      STATE.stats.winTrades   = s.winTrades   || 0;
      STATE.stats.totalProfit = s.totalProfit || 0;
      // dailyProfit는 날짜가 바뀌면 초기화
      const today = new Date().toDateString();
      if (s.statsDate === today) {
        STATE.stats.dailyProfit = s.dailyProfit || 0;
      } else {
        STATE.stats.dailyProfit = 0;
      }
    } catch(e) {}
  }

  // market 복원
  const savedMarket = localStorage.getItem('bot_market') || 'KR';
  STATE.market = savedMarket;
  ['KR','US','BOTH'].forEach(m => {
    const el = document.getElementById('market-' + m);
    if (el) el.classList.toggle('active-market', m === savedMarket);
  });
  // 환율 패널 표시 여부
  const fxPanel = document.getElementById('fx-panel');
  if (fxPanel) fxPanel.classList.toggle('hidden', savedMarket === 'KR');

  const p  = STATE.config.profitTarget;
  const sl = STATE.config.stopLoss;
  const mp = STATE.config.maxPositions;
  const pc = Math.round(STATE.config.paperCapital / 1000000);

  document.getElementById('profit-target').value      = p;
  document.getElementById('profit-target-num').value  = p;
  document.getElementById('stop-loss').value          = sl;
  document.getElementById('stop-loss-num').value      = sl;
  document.getElementById('max-positions').value      = mp;
  document.getElementById('max-positions-num').value  = mp;
  document.getElementById('paper-capital').value      = pc;
  document.getElementById('paper-capital-num').value  = pc;
  document.getElementById('strategy-select').value    = localStorage.getItem('bot_strategy') || 'scalping';

  // 레이블 갱신
  document.getElementById('profit-val').textContent        = parseFloat(p).toFixed(1) + '%';
  document.getElementById('stoploss-val').textContent      = parseFloat(sl).toFixed(1) + '%';
  document.getElementById('maxpos-val').textContent        = mp + '개';
  document.getElementById('maxpos-display').textContent    = mp;
  document.getElementById('paper-capital-val').textContent = pc + '00만원';

  // 포지션 금액 범위 UI 복원
  // 저장된 값이 없으면(최초 실행) 자본금 기반 기본값으로 초기화
  const hasRange = saved && JSON.parse(saved).posMinAmt;
  if (!hasRange) {
    applyDefaultPositionRange(STATE.config.paperCapital, true);
  } else {
    // 저장된 값 UI에 반영
    const minAmt = STATE.config.posMinAmt;
    const maxAmt = STATE.config.posMaxAmt;
    const cap    = STATE.config.posCapMult;
    const slMax  = Math.max(STATE.config.paperCapital, 1000000);
    document.getElementById('pos-min').max   = slMax;
    document.getElementById('pos-max').max   = slMax;
    document.getElementById('pos-min').value = minAmt;
    document.getElementById('pos-max').value = maxAmt;
    document.getElementById('pos-min-num').value = Math.round(minAmt / 10000);
    document.getElementById('pos-max-num').value = Math.round(maxAmt / 10000);
    document.getElementById('pos-cap').value     = cap;
    applyDefaultPositionRange(STATE.config.paperCapital, false);
    refreshPosRangeUI();
  }
}

/** stats → localStorage 저장 (Kelly 계산 세션 간 연속성) */
function saveStats() {
  localStorage.setItem('bot_stats', JSON.stringify({
    totalTrades: STATE.stats.totalTrades,
    winTrades:   STATE.stats.winTrades,
    totalProfit: STATE.stats.totalProfit,
    dailyProfit: STATE.stats.dailyProfit,
    statsDate:   new Date().toDateString(),
  }));
}

/** 슬라이더 변경 시 STATE → localStorage 자동저장 (로그 없이) */
function autoSaveConfig() {
  STATE.config.paperCapital = parseInt(document.getElementById('paper-capital').value) * 1000000 || STATE.config.paperCapital;
  localStorage.setItem('bot_config', JSON.stringify(STATE.config));
  localStorage.setItem('bot_strategy', document.getElementById('strategy-select')?.value || STATE.strategy);
}

function saveConfig() {
  STATE.config.profitTarget      = parseFloat(document.getElementById('profit-target').value);
  STATE.config.stopLoss          = parseFloat(document.getElementById('stop-loss').value);
  STATE.config.maxPositions      = parseInt(document.getElementById('max-positions').value);
  STATE.config.posMinAmt         = parseInt(document.getElementById('pos-min').value);
  STATE.config.posMaxAmt         = parseInt(document.getElementById('pos-max').value);
  STATE.config.posCapMult        = parseFloat(document.getElementById('pos-cap').value);
  STATE.strategy                 = document.getElementById('strategy-select').value;
  localStorage.setItem('bot_config', JSON.stringify(STATE.config));
  localStorage.setItem('bot_strategy', STATE.strategy);
  saveStats(); // 설정 저장 시 stats도 함께 저장
  // 카드 동기화
  document.getElementById('maxpos-display').textContent = STATE.config.maxPositions;
  renderPosSlots();
  const finalMax = Math.round(STATE.config.posMaxAmt * STATE.config.posCapMult / 10000) * 10000;
  addLog('info', `💾 설정 저장 — 최대포지션: ${STATE.config.maxPositions}개, 익절: ${STATE.config.profitTarget}%, 손절: ${STATE.config.stopLoss}%`);
  addLog('info', `   포지션 금액: ${fmtManwon(STATE.config.posMinAmt)} ~ ${fmtManwon(finalMax)} (상한율 ${STATE.config.posCapMult.toFixed(1)}×)`);
  renderStrategyConditions();
  updateStatsUI();
}

// ─── 적응형 진입 조건 파라미터 ────────────────────────────────
// 4단계: 0=공격(완화) 1=기본(표준) 2=방어(강화) 3=대기(매우강화)
// 승률 기준: ≥65% → 공격 | 40~64% → 기본 | 25~39% → 방어 | <25% → 대기
const ADAPTIVE_PARAMS = {
  scalping: [
    // 0: 공격 — 승률 ≥ 65%, 조건 완화
    {
      label: '🟢 공격', labelShort: '공격',
      rsiMin: 40, rsiMax: 60,         // RSI 40~60 (20%p)
      volMult: 1.3,                    // 거래량 1.3배
      pctMin: 0.2, pctMax: 2.5,       // 가격변동 0.2~2.5%
      buyPressure: 0.50,              // 매수압력 ≥ 0.50 (캔들 중간 이상 마감)
      scoreBonus: 10,
      desc: '승률 ≥ 65% — 진입 조건 완화, 공격적 매수',
    },
    // 1: 기본 — 승률 40~64%
    {
      label: '🔵 기본', labelShort: '기본',
      rsiMin: 45, rsiMax: 55,         // RSI 45~55 (10%p)
      volMult: 1.5,
      pctMin: 0.3, pctMax: 2.0,
      buyPressure: 0.55,              // 매수압력 ≥ 0.55
      scoreBonus: 0,
      desc: '승률 40~64% — 표준 진입 조건',
    },
    // 2: 방어 — 승률 25~39%
    {
      label: '🟡 방어', labelShort: '방어',
      rsiMin: 47, rsiMax: 53,         // RSI 47~53 (6%p)
      volMult: 2.0,
      pctMin: 0.4, pctMax: 1.5,
      buyPressure: 0.60,              // 매수압력 ≥ 0.60
      scoreBonus: -5,
      desc: '승률 25~39% — 조건 강화, 고확률 종목만 진입',
    },
    // 3: 대기 — 승률 < 25%
    {
      label: '🔴 대기', labelShort: '대기',
      rsiMin: 48, rsiMax: 52,         // RSI 48~52 (4%p) — 가장 엄격
      volMult: 2.5,
      pctMin: 0.5, pctMax: 1.0,
      buyPressure: 0.65,              // 매수압력 ≥ 0.65 (캔들 상위 35% 마감)
      scoreBonus: -15,
      desc: '승률 < 25% — 진입 최소화, 손실 방어 최우선',
    },
  ],
  volume: [
    { label: '🟢 공격', labelShort: '공격', volMult: 1.5, pctMin: 0.3, pctMax: 6.0, rsiMax: 75, desc: '승률 ≥ 65%' },
    { label: '🔵 기본', labelShort: '기본', volMult: 2.0, pctMin: 0.5, pctMax: 5.0, rsiMax: 70, desc: '승률 40~64%' },
    { label: '🟡 방어', labelShort: '방어', volMult: 2.8, pctMin: 0.7, pctMax: 3.5, rsiMax: 65, desc: '승률 25~39%' },
    { label: '🔴 대기', labelShort: '대기', volMult: 3.5, pctMin: 1.0, pctMax: 2.5, rsiMax: 60, desc: '승률 < 25%' },
  ],
  momentum: [
    { label: '🟢 공격', labelShort: '공격', volMult: 1.0, pctMin: 0.5, adx: 20, desc: '승률 ≥ 65%' },
    { label: '🔵 기본', labelShort: '기본', volMult: 1.3, pctMin: 1.0, adx: 25, desc: '승률 40~64%' },
    { label: '🟡 방어', labelShort: '방어', volMult: 1.6, pctMin: 1.5, adx: 30, desc: '승률 25~39%' },
    { label: '🔴 대기', labelShort: '대기', volMult: 2.0, pctMin: 2.0, adx: 35, desc: '승률 < 25%' },
  ],
  mean_reversion: [
    { label: '🟢 공격', labelShort: '공격', rsiMax: 35, pctMin: -1.0, desc: '승률 ≥ 65%' },
    { label: '🔵 기본', labelShort: '기본', rsiMax: 30, pctMin: -1.5, desc: '승률 40~64%' },
    { label: '🟡 방어', labelShort: '방어', rsiMax: 25, pctMin: -2.0, desc: '승률 25~39%' },
    { label: '🔴 대기', labelShort: '대기', rsiMax: 20, pctMin: -3.0, desc: '승률 < 25%' },
  ],
};

/** 승률 → 적응 단계(0~3) 반환 */
function calcAdaptiveMode() {
  const results = STATE.recentResults;          // 최근 거래 결과 배열
  if (results.length < 3) return;              // 3회 미만이면 갱신 안 함
  const sample  = results.slice(-10);          // 최근 10회만
  const wins    = sample.filter(r => r.win).length;
  const winRate = (wins / sample.length) * 100;

  const prev = STATE.adaptiveMode;
  if      (winRate >= 65) STATE.adaptiveMode = 0;  // 공격
  else if (winRate >= 40) STATE.adaptiveMode = 1;  // 기본
  else if (winRate >= 25) STATE.adaptiveMode = 2;  // 방어
  else                    STATE.adaptiveMode = 3;  // 대기

  if (STATE.adaptiveMode !== prev) {
    const ap    = ADAPTIVE_PARAMS.scalping[STATE.adaptiveMode]; // 대표명
    const names = ['🟢 공격', '🔵 기본', '🟡 방어', '🔴 대기'];
    addLog('info',
      `📊 적응 모드 변경: ${names[prev]} → ${names[STATE.adaptiveMode]} ` +
      `(최근 ${sample.length}회 승률 ${winRate.toFixed(0)}%)`);
  }
  updateAdaptiveBadge();
  renderStrategyConditions();  // 진입 조건 패널도 즉시 갱신
}

/** 상단 배지 + 포지션 카드 배지 갱신 */
function updateAdaptiveBadge() {
  const mode  = STATE.adaptiveMode;
  const names = ['🟢 공격', '🔵 기본', '🟡 방어', '🔴 대기'];
  const colors= [
    'bg-green-900/60 text-green-300 border-green-700',
    'bg-blue-900/60  text-blue-300  border-blue-700',
    'bg-yellow-900/60 text-yellow-300 border-yellow-700',
    'bg-red-900/60   text-red-300   border-red-700',
  ];
  const cls = `text-xs px-2 py-0.5 rounded border font-medium ${colors[mode]}`;
  ['adaptive-badge', 'adaptive-badge-2'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = names[mode];
    el.className   = cls;
  });

  // 최근 승률 표시
  const sample  = STATE.recentResults.slice(-10);
  const wins    = sample.filter(r => r.win).length;
  const rateEl  = document.getElementById('adaptive-winrate');
  if (rateEl) {
    rateEl.textContent = sample.length > 0
      ? `최근 ${sample.length}회 승률 ${Math.round(wins/sample.length*100)}%`
      : '거래 없음';
  }
}

// ─── 전략 조건 표시 ───────────────────────────────────────────
const STRATEGY_META = {
  scalping: {
    name: '⚡ 스캘핑 전략',
    interval: 15,
    conditions: [
      { label: '1분 가격 변동', value: '0.3% ~ 2.0%', color: 'blue' },
      { label: '거래량 증가', value: '1.5배 이상', color: 'green' },
      { label: 'RSI', value: '35 ~ 65', color: 'purple' },
      { label: '매수 압력', value: '1.2배 이상', color: 'yellow' },
    ],
  },
  volume: {
    name: '📊 거래량 급증 전략',
    interval: 30,
    conditions: [
      { label: '거래량 폭증', value: '2.0배 이상', color: 'pink' },
      { label: '가격 모멘텀', value: '0.5% ~ 5%', color: 'blue' },
      { label: 'RSI', value: '70 이하', color: 'purple' },
      { label: '시가총액', value: '1000억 이상 권장', color: 'gray' },
    ],
  },
  momentum: {
    name: '🚀 모멘텀 추종 전략',
    interval: 60,
    conditions: [
      { label: '5일 이동평균 돌파', value: '상향 돌파 시', color: 'green' },
      { label: '거래량 확인', value: '평균 대비 1.3배', color: 'blue' },
      { label: '추세 강도', value: 'ADX ≥ 25', color: 'yellow' },
      { label: '52주 고가 대비', value: '80% 이상', color: 'orange' },
    ],
  },
  mean_reversion: {
    name: '↩️ 평균 회귀 전략',
    interval: 120,
    conditions: [
      { label: '볼린저 밴드', value: '하단 이탈 후 진입', color: 'cyan' },
      { label: 'RSI 과매도', value: '30 이하', color: 'red' },
      { label: '이격도', value: '5일선 -3% 이하', color: 'orange' },
      { label: '시장 상황', value: '횡보/반등 구간', color: 'gray' },
    ],
  },
};

const COLOR_MAP = {
  blue: 'text-blue-400', green: 'text-green-400', purple: 'text-purple-400',
  yellow: 'text-yellow-400', pink: 'text-pink-400', gray: 'text-gray-400',
  red: 'text-red-400', cyan: 'text-cyan-400', orange: 'text-orange-400',
};

function renderStrategyConditions() {
  const strat = document.getElementById('strategy-select')?.value || STATE.strategy;
  const meta  = STRATEGY_META[strat] || STRATEGY_META.scalping;
  STATE.config.scanInterval = meta.interval;
  document.getElementById('bot-interval-label').textContent = meta.interval + '초';

  const profitTarget = parseFloat(document.getElementById('profit-target')?.value || STATE.config.profitTarget);
  const stopLoss     = parseFloat(document.getElementById('stop-loss')?.value     || STATE.config.stopLoss);

  // ── 적응형 파라미터로 진입 조건 표시 ──────────────────────
  const ap      = (ADAPTIVE_PARAMS[strat] || ADAPTIVE_PARAMS.scalping)[STATE.adaptiveMode];
  const condEl  = document.getElementById('strategy-conditions');
  const modeColors = ['text-green-400','text-blue-400','text-yellow-400','text-red-400'];
  const mc = modeColors[STATE.adaptiveMode];

  // 스캘핑은 RSI 표시, 거래량/모멘텀/평균회귀는 해당 핵심 조건 표시
  let condRows = '';
  if (strat === 'scalping') {
    condRows = `
      <div class="flex justify-between items-center bg-gray-800/50 rounded px-2 py-1.5">
        <span class="text-gray-400">RSI 범위</span>
        <span class="${mc} font-medium">${ap.rsiMin} ~ ${ap.rsiMax} <span class="text-gray-600 text-xs">(${ap.rsiMax-ap.rsiMin}%p)</span></span>
      </div>
      <div class="flex justify-between items-center bg-gray-800/50 rounded px-2 py-1.5">
        <span class="text-gray-400">가격 변동</span>
        <span class="${mc} font-medium">${ap.pctMin}% ~ ${ap.pctMax}%</span>
      </div>
      <div class="flex justify-between items-center bg-gray-800/50 rounded px-2 py-1.5">
        <span class="text-gray-400">거래량 배수</span>
        <span class="${mc} font-medium">${ap.volMult}× 이상</span>
      </div>
      <div class="flex justify-between items-center bg-gray-800/50 rounded px-2 py-1.5">
        <span class="text-gray-400">매수 압력</span>
        <span class="${mc} font-medium">${ap.buyPressure}× 이상</span>
      </div>`;
  } else {
    condRows = meta.conditions.map(c => `
      <div class="flex justify-between items-center bg-gray-800/50 rounded px-2 py-1.5">
        <span class="text-gray-400">${c.label}</span>
        <span class="${COLOR_MAP[c.color]||'text-gray-300'} font-medium">${c.value}</span>
      </div>`).join('');
    // 적응형 핵심 조건 추가 표시
    if (ap.volMult) condRows += `
      <div class="flex justify-between items-center bg-gray-800/60 rounded px-2 py-1.5 border-l-2 border-l-${modeColors[STATE.adaptiveMode].split('-')[1]}-500">
        <span class="text-gray-500 text-xs">📊 적응 거래량 기준</span>
        <span class="${mc} text-xs font-medium">${ap.volMult}× 이상</span>
      </div>`;
    if (ap.pctMin !== undefined) condRows += `
      <div class="flex justify-between items-center bg-gray-800/60 rounded px-2 py-1.5 border-l-2 border-l-${modeColors[STATE.adaptiveMode].split('-')[1]}-500">
        <span class="text-gray-500 text-xs">📊 적응 가격 기준</span>
        <span class="${mc} text-xs font-medium">${ap.pctMin > 0 ? '+' : ''}${ap.pctMin}% ~</span>
      </div>`;
  }

  condEl.innerHTML = condRows;

  const exitEl = document.getElementById('exit-conditions');
  const fee  = 0.245;
  const ep   = EXIT_PARAMS[strat] || EXIT_PARAMS.scalping;
  const trailTrigger = (profitTarget * ep.trailTriggerMult).toFixed(2);
  const trailCut     = (profitTarget * ep.trailTriggerMult + ep.trailDropPct).toFixed(2);
  exitEl.innerHTML = `
    <div class="flex justify-between items-start">
      <span class="text-gray-500">🔒 트레일 발동</span>
      <span class="text-orange-400 text-right">+${trailTrigger}% 도달 시<br><span class="text-gray-500 text-xs">(목표 ${profitTarget}% × ${ep.trailTriggerMult}×)</span></span>
    </div>
    <div class="flex justify-between items-start">
      <span class="text-gray-500">↘ 트레일 청산</span>
      <span class="text-yellow-400 text-right">고점에서 -${ep.trailDropPct}%p 하락<br><span class="text-gray-500 text-xs">예: 고점 +2%→ +${(2-ep.trailDropPct).toFixed(1)}% 이하 시 매도</span></span>
    </div>
    <div class="flex justify-between"><span class="text-gray-500">🚨 손절</span><span class="text-red-400">-${stopLoss}% (실제 -${(stopLoss + fee).toFixed(2)}%)</span></div>
    <div class="flex justify-between"><span class="text-gray-500">💸 슬리피지</span><span class="text-purple-400">-${ep.slippagePct}% (시장가 체결 미끄러짐)</span></div>
    <div class="flex justify-between"><span class="text-gray-500">⏰ 시간 청산</span><span class="text-yellow-400">${Math.round(ep.maxHoldSec/60)}분 초과</span></div>
    <div class="flex justify-between text-gray-600 pt-1 border-t border-gray-800 mt-1"><span>총 비용</span><span>수수료 ${fee}% + 슬리피지 ${ep.slippagePct}% = ${(fee+ep.slippagePct).toFixed(3)}%</span></div>
  `;
}

// ─── 봇 시작 / 정지 ───────────────────────────────────────────
async function toggleBot() {
  if (STATE.running) {
    stopBot();
  } else {
    await startBot();
  }
}

async function startBot() {
  if (STATE.mode === 'live' && !KEYS.appKey) {
    addLog('error', '❌ 실전 모드: API 키가 없습니다');
    openApiSettings();
    return;
  }

  saveConfig();
  STATE.running = true;
  STATE._balWarnedOnce = false;  // 봇 재시작 시 경고 플래그 초기화

  // 다른 탭/기기에 "봇 시작" 알림 → 해당 탭은 자동 정지
  notifyBotStarted();

  // 기존 포지션이 없을 때만 페이퍼 잔고 초기화 (재시작 시 포지션 유지)
  const hasExistingPos = STATE.positions.length > 0;
  if (!hasExistingPos) STATE.paperBalance = STATE.config.paperCapital;

  // US / BOTH 모드: 페이퍼 달러 잔고 초기화 (각 시장 100% 독립)
  if (STATE.mode === 'paper' && !hasExistingPos) {
    if (STATE.market === 'US') {
      STATE.paperBalanceUsd = STATE.config.paperCapital / STATE.usdKrw;
      STATE.paperBalance = 0;
      addLog('info', `💵 페이퍼 달러 잔고 초기화: $${STATE.paperBalanceUsd.toFixed(2)} (환율 ${fmtPrice(STATE.usdKrw)}원/달러)`);
    } else if (STATE.market === 'BOTH') {
      // 국내/미국 각 100% 독립 — 시간대가 달라 동시 투자 없음
      STATE.paperBalanceUsd = STATE.config.paperCapital / STATE.usdKrw;
      STATE.paperBalance = STATE.config.paperCapital;
      addLog('info', `🌏 페이퍼 자본: 국내 ${fmtManwon(STATE.paperBalance)} / 미국 $${STATE.paperBalanceUsd.toFixed(2)} (각 100%)`);
    } else {
      // KR 모드: 달러 잔고 불필요
      STATE.paperBalanceUsd = 0;
    }
  }

  const btn = document.getElementById('bot-toggle-btn');
  btn.innerHTML = '<i class="fas fa-stop mr-2"></i> 봇 정지';
  btn.className = 'w-full py-3 rounded-lg text-base font-bold transition bg-red-600 hover:bg-red-700';
  document.getElementById('bot-running-label').textContent = '🟢 실행 중';
  document.getElementById('bot-running-label').className   = 'text-green-400';

  const modeName = STATE.mode === 'paper' ? '📄 페이퍼' : '🔴 실전';
  const stratName = STRATEGY_META[STATE.strategy]?.name || STATE.strategy;
  addLog('info', `🚀 봇 시작 — 모드: ${modeName} | 전략: ${stratName}`);
  const posMaxFinal = Math.round(STATE.config.posMaxAmt * STATE.config.posCapMult / 10000) * 10000;
  addLog('info', `   익절: +${STATE.config.profitTarget}% | 손절: -${STATE.config.stopLoss}% | 최대포지션: ${STATE.config.maxPositions}개`);
  addLog('info', `   포지션 금액: ${fmtManwon(STATE.config.posMinAmt)} ~ ${fmtManwon(posMaxFinal)} (상한율 ${STATE.config.posCapMult.toFixed(1)}×)`);

  // 장 시간 안내
  if (STATE.mode === 'live') {
    if (isMarketOpen()) {
      addLog('info', `   🟢 현재 정규장 시간 — 즉시 매매 활성`);
    } else {
      addLog('warn', `   ⚫ 현재 장 외 시간 — 신규 진입 차단, 보유 포지션 청산 체크만 진행`);
      if (mkt === 'KR' || mkt === 'BOTH')
        addLog('warn', `   📅 🇰🇷 국내 다음 개장: ${getNextOpenStr('KR')}`);
      if (mkt === 'US' || mkt === 'BOTH')
        addLog('warn', `   📅 🇺🇸 미국 다음 개장: ${getNextOpenStr('US')}`);
    }
  } else {
    addLog('info', `   📄 페이퍼 모드 — 장 시간 무관하게 시뮬레이션 실행`);
  }

  // 즉시 1회 스캔 후 주기 실행
  await runScan();
  scheduleNextScan();
}

function stopBot() {
  STATE.running = false;
  clearTimeout(STATE.scanTimer);
  clearInterval(STATE.countdownTimer);

  const btn = document.getElementById('bot-toggle-btn');
  btn.innerHTML = '<i class="fas fa-play mr-2"></i> 봇 시작';
  btn.className = 'w-full py-3 rounded-lg text-base font-bold transition bg-green-600 hover:bg-green-700';
  document.getElementById('bot-running-label').textContent = '⭕ 정지';
  document.getElementById('bot-running-label').className   = 'text-gray-400';
  document.getElementById('next-scan-label').textContent   = '-';
  addLog('warn', '⏹️ 봇 정지');
}

function scheduleNextScan() {
  if (!STATE.running) return;
  const interval = STATE.config.scanInterval * 1000;
  STATE.nextScanIn = STATE.config.scanInterval;

  clearInterval(STATE.countdownTimer);
  STATE.countdownTimer = setInterval(() => {
    STATE.nextScanIn--;
    document.getElementById('next-scan-label').textContent = STATE.nextScanIn + '초 후';
    if (STATE.nextScanIn <= 0) clearInterval(STATE.countdownTimer);
  }, 1000);

  STATE.scanTimer = setTimeout(async () => {
    if (!STATE.running) return;
    await runScan();
    scheduleNextScan();
  }, interval);
}

// ============================================================
// ── 텔레그램 알림 (장 마감 리포트)
// ============================================================

/** localStorage에서 텔레그램 키 로드 */
const TG = {
  get botToken() { return localStorage.getItem('tg_bot_token') || ''; },
  get chatId()   { return localStorage.getItem('tg_chat_id')   || ''; },
  get enabled()  { return !!(TG.botToken && TG.chatId); },
};

/** 설정 UI → localStorage 저장 */
function saveTelegramKeys() {
  let tok = document.getElementById('tg-bot-token')?.value.trim();
  const cid = document.getElementById('tg-chat-id')?.value.trim();
  // 토큰 비어있으면 기존 저장값 유지
  if (!tok) tok = TG.botToken;
  const el = document.getElementById('tg-test-result');
  const showMsg = (msg, color) => {
    if (!el) { alert(msg); return; }
    el.textContent = msg;
    el.className = `text-xs text-center mt-2 ${color}`;
    el.style.display = 'block';
  };
  if (!tok || !cid) {
    showMsg('⚠️ Bot Token과 Chat ID를 모두 입력하세요', 'text-yellow-400');
    return;
  }
  localStorage.setItem('tg_bot_token', tok);
  localStorage.setItem('tg_chat_id',   cid);
  // placeholder 갱신
  const el1 = document.getElementById('tg-bot-token');
  if (el1) { el1.value = ''; el1.placeholder = '저장됨 (변경하려면 새로 입력)'; }
  showMsg('✅ 저장 완료!', 'text-green-400');
  addLog('info', '📱 텔레그램 설정 저장 완료 (Chat ID: ' + cid + ')');
}

/** 페이지 로드 시 설정 UI 복원 */
function loadTelegramKeys() {
  const el1 = document.getElementById('tg-bot-token');
  const el2 = document.getElementById('tg-chat-id');
  // 토큰은 placeholder로 저장됨 표시 (value는 비워둬서 재입력 없이도 저장 가능)
  if (el1) {
    el1.value = '';
    el1.placeholder = TG.botToken ? '저장됨 (변경하려면 새로 입력)' : '예: 1234567890:ABCDEFGabcdefg...';
  }
  if (el2 && TG.chatId) el2.value = TG.chatId;
}

/** 텔레그램 메시지 전송 (서버 프록시 경유) */
async function sendTelegram(text) {
  if (!TG.enabled) return false;
  try {
    const res = await fetch('/api/telegram/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken: TG.botToken, chatId: TG.chatId, text }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!data.ok) {
      addLog('warn', `⚠️ 텔레그램 전송 실패 — ${data.error}`);
      return false;
    }
    return true;
  } catch(e) {
    addLog('warn', `⚠️ 텔레그램 전송 오류 — ${e?.message || e}`);
    return false;
  }
}

/** 테스트 전송 버튼 */
async function testTelegram() {
  const resultEl = document.getElementById('tg-test-result');
  const showMsg = (msg, color) => {
    if (!resultEl) { alert(msg); return; }
    resultEl.textContent = msg;
    resultEl.className   = `text-xs text-center mt-2 ${color}`;
    resultEl.style.display = 'block';
  };
  // 저장된 값 없으면 먼저 저장 유도
  if (!TG.enabled) {
    showMsg('⚠️ 먼저 Bot Token과 Chat ID를 입력 후 저장하세요', 'text-yellow-400');
    return;
  }
  showMsg('⏳ 전송 중...', 'text-gray-400');
  const ok = await sendTelegram('📈 <b>StockBot 테스트 메시지</b>\n✅ 텔레그램 연결 성공! 장 마감 시 리포트가 전송됩니다.');
  showMsg(ok ? '✅ 전송 성공! 텔레그램 확인하세요' : '❌ 전송 실패 — 토큰/Chat ID를 다시 확인하세요', ok ? 'text-green-400' : 'text-red-400');
}

/**
 * 장 마감 리포트 생성 및 전송
 * @param {'KR'|'US'} market
 */
async function sendCloseReport(market) {
  if (!TG.enabled) return;

  const flag   = market === 'KR' ? '🇰🇷' : '🇺🇸';
  const mktStr = market === 'KR' ? '국내(KRX)' : '미국(NYSE/NAS)';
  const now    = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  // ── 오늘 해당 시장 거래 내역 필터 ──────────────────────────────
  const today = new Date().toDateString();
  const trades = (STATE.recentResults || []).filter(r => {
    if (!r.closedAt) return false;
    if (new Date(r.closedAt).toDateString() !== today) return false;
    if (market === 'US') return r.market === 'US';
    return r.market !== 'US';
  });

  // ── 집계 ──────────────────────────────────────────────────────
  const total   = trades.length;
  const wins    = trades.filter(r => r.win).length;
  const losses  = total - wins;
  const winRate = total > 0 ? Math.round(wins / total * 100) : 0;

  // 손익금 합계 (원화 기준)
  const totalPnlAmt = trades.reduce((sum, r) => {
    const amt = r.pnlAmt ?? (r.pnlPct != null && r.entryAmt ? r.pnlPct / 100 * r.entryAmt : 0);
    return sum + (amt || 0);
  }, 0);

  // 평균 손익률
  const avgPnlPct = total > 0
    ? trades.reduce((s, r) => s + (r.pnlPct || 0), 0) / total
    : 0;

  // 일일 손익금 (STATE.stats.dailyProfit 기반 — 전체 시장 포함)
  const dailyPnl = STATE.stats.dailyProfit || 0;

  // ── 메시지 구성 ────────────────────────────────────────────────
  const pnlSign  = totalPnlAmt >= 0 ? '+' : '';
  const pnlEmoji = totalPnlAmt >= 0 ? '📈' : '📉';
  const modeTag  = STATE.mode === 'paper' ? '[페이퍼]' : '[실전]';

  let msg = `${flag} <b>StockBot ${mktStr} 장 마감 리포트</b> ${modeTag}\n`;
  msg    += `🕐 ${now} KST\n`;
  msg    += `━━━━━━━━━━━━━━━━━━\n`;

  if (total === 0) {
    msg += `오늘 ${mktStr} 거래 없음\n`;
  } else {
    msg += `📊 <b>오늘 거래: ${total}건</b> (승 ${wins} / 패 ${losses})\n`;
    msg += `🎯 승률: <b>${winRate}%</b>\n`;
    msg += `${pnlEmoji} 손익: <b>${pnlSign}${fmtPrice(totalPnlAmt)}원</b>`;
    if (totalPnlAmt !== 0) msg += ` (평균 ${pnlSign}${avgPnlPct.toFixed(2)}%)`;
    msg += '\n';
  }

  // 개별 거래 내역 (최대 10건)
  if (trades.length > 0) {
    msg += `\n<b>📋 거래 내역</b>\n`;
    const shown = trades.slice(-10);
    for (const r of shown) {
      const p   = r.pnlPct != null ? (r.pnlPct >= 0 ? '+' : '') + r.pnlPct.toFixed(2) + '%' : '-';
      const amt = r.pnlAmt != null ? (r.pnlAmt >= 0 ? '+' : '') + fmtPrice(r.pnlAmt) + '원' : '';
      const ico = r.win ? '✅' : '❌';
      msg += `${ico} ${r.name || r.ticker}  ${p}${amt ? ' (' + amt + ')' : ''}\n`;
    }
    if (trades.length > 10) msg += `  … 외 ${trades.length - 10}건\n`;
  }

  // 오늘 전체 누적 손익
  msg += `━━━━━━━━━━━━━━━━━━\n`;
  msg += `💰 오늘 전체 누적: <b>${dailyPnl >= 0 ? '+' : ''}${fmtPrice(dailyPnl)}원</b>\n`;

  // 현재 보유 포지션 중 해당 시장 것만
  const openPos = STATE.positions.filter(p => market === 'US' ? p.market === 'US' : p.market !== 'US');
  if (openPos.length > 0) {
    msg += `\n⏳ <b>미청산 보유 ${openPos.length}개</b>\n`;
    for (const p of openPos.slice(0, 5)) {
      const cur  = p.currentPrice || p.entryPrice;
      const pct  = p.entryPrice > 0 ? ((cur - p.entryPrice) / p.entryPrice * 100) : 0;
      msg += `  • ${p.name || p.ticker}  ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%\n`;
    }
    if (openPos.length > 5) msg += `  … 외 ${openPos.length - 5}개\n`;
  }

  addLog('info', `📱 텔레그램 ${mktStr} 마감 리포트 전송 중...`);
  const ok = await sendTelegram(msg);
  if (ok) addLog('info', `✅ 텔레그램 ${mktStr} 마감 리포트 전송 완료`);
}

// ─── 메인 스캔 로직 ───────────────────────────────────────────
async function runScan() {
  const mkt = STATE.market;
  const krOpen = isKrMarketOpen();
  const usOpen = isUsMarketOpen();
  const anyOpen = isMarketOpen();
  const modeName = STATE.mode === 'paper' ? '페이퍼' : '실전';
  const mktLabel = { KR: '🇰🇷국내', US: '🇺🇸미국', BOTH: '🌏국내+미국' }[mkt] || mkt;

  // ── 장 마감 전 자동 청산 + 신규 매수 차단 ─────────────────────
  // checkPositionsForExit()이 마감 준비 구간 감지 → 완화 파라미터로 자연 청산
  // 여기서는 로그 안내 + 플래그 관리만 담당 (강제 즉시청산 없음)
  if (STATE.mode !== 'paper') {

    // ─ [국내] 마감 1시간 전 (14:30~): 신규 매수 차단 + 완화 청산 시작 알림
    if ((mkt === 'KR' || mkt === 'BOTH') && isKrMarketPreClose() && !STATE.krPreCloseSent) {
      STATE.krPreCloseSent = true;
      const krPos = STATE.positions.filter(p => p.market === 'KR' || !p.market);
      if (krPos.length > 0) {
        addLog('warn', `⏰ [국내] 장 마감 1시간 전 (14:30) — 신규 매수 차단, 보유 ${krPos.length}개 완화 청산 조건 적용`);
        addLog('info', `   트레일 발동 기준 낮춤 · 낙폭 허용 좁힘 · 이익 있으면 우선 수익 확정`);
      } else {
        addLog('info', '⏰ [국내] 장 마감 1시간 전 (14:30) — 신규 매수 차단 시작');
      }
    }
    // 국내 장 열리면 (09:00~14:29) 플래그 초기화
    if (krOpen && !isKrMarketPreClose()) {
      STATE.krPreCloseSent  = false;
      STATE.krCloseAlertSent = false;
    }

    // ─ [미국] 마감 30분 전: 신규 매수 차단 + 완화 청산 시작 알림
    if ((mkt === 'US' || mkt === 'BOTH') && isUsMarketClosingSoon() && !STATE.usCloseAlertSent) {
      STATE.usCloseAlertSent = true;
      const usPos = STATE.positions.filter(p => p.market === 'US');
      if (usPos.length > 0) {
        addLog('warn', `⏰ [미국] 장 마감 30분 전 (04:30 KST) — 신규 매수 차단, 보유 ${usPos.length}개 완화 청산 조건 적용`);
        addLog('info', `   트레일 발동 기준 낮춤 · 낙폭 허용 좁힘 · 이익 있으면 우선 수익 확정`);
      }
    }
    // 미국 장 열리면 플래그 초기화
    if (usOpen && !isUsMarketClosingSoon()) STATE.usCloseAlertSent = false;
  }

  // ── 텔레그램 마감 리포트 트리거 ─────────────────────────────────
  // 국내: 장이 방금 닫힌 직후 1회만 (krOpen이 false로 바뀐 첫 스캔)
  // 미국: 장이 방금 닫힌 직후 1회만 (usOpen이 false로 바뀐 첫 스캔)
  if (TG.enabled) {
    // 국내 마감 감지
    if ((mkt === 'KR' || mkt === 'BOTH') && !krOpen && STATE._krWasOpen) {
      STATE._krWasOpen = false;
      sendCloseReport('KR');  // 비동기 — 스캔 블록 안 함
    }
    if (krOpen) STATE._krWasOpen = true;

    // 미국 마감 감지
    if ((mkt === 'US' || mkt === 'BOTH') && !usOpen && STATE._usWasOpen) {
      STATE._usWasOpen = false;
      sendCloseReport('US');
    }
    if (usOpen) STATE._usWasOpen = true;
  }

  // ─ 장 외 시간 안내 (시장별 구분 로그)
  if (STATE.mode === 'live') {
    const now5m = Date.now() - STATE._lastMarketClosedLog > 5 * 60 * 1000;
    // KR 모드 또는 BOTH에서 KR 닫혔을 때
    if ((mkt === 'KR' || mkt === 'BOTH') && !krOpen && now5m) {
      addLog('warn', `⏸️  🇰🇷 국내 장 외 시간 — 신규 진입 차단 (다음 개장: ${getNextOpenStr('KR')})`);
      STATE._lastMarketClosedLog = Date.now();
    }
    // US 모드 또는 BOTH에서 US 닫혔을 때
    if ((mkt === 'US' || mkt === 'BOTH') && !usOpen && now5m) {
      addLog('warn', `⏸️  🇺🇸 미국 장 외 시간 — 신규 진입 차단 (다음 개장: ${getNextOpenStr('US')})`);
      STATE._lastMarketClosedLog = Date.now();
    }
  }

  const stratName = (STATE.strategy || 'scalping').toUpperCase();
  const timeStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const mktSt = (mkt==='KR') ? (krOpen?'🟢정규장':'⚫마감')
              : (mkt==='US') ? (usOpen?'🔵야간장':'⚫마감')
              : `KR:${krOpen?'🟢':'⚫'} US:${usOpen?'🔵':'⚫'}`;
  addLog('scan', `🔍 [스캔 ${timeStr}] ${stratName} | ${modeName} | ${mktLabel} ${mktSt}`);

  // 1) 포지션 청산 체크 — 장 외에도 실행 (손절·트레일 보호)
  await checkPositionsForExit();

  // 2) 신규 진입 — 정규장 시간 + 마감 준비 시간이 아닐 때만 허용 (페이퍼 모드는 항상)
  //    국내: 14:30부터 신규 매수 차단 (마감 1시간 전)
  //    미국: 04:30부터 신규 매수 차단 (마감 30분 전)
  const preCloseKr = (mkt === 'KR' || mkt === 'BOTH') && isKrMarketPreClose();
  const closingUs  = (mkt === 'US'  || mkt === 'BOTH') && isUsMarketClosingSoon();
  const blocked    = STATE.mode === 'live' && (preCloseKr || closingUs);
  const canEnter   = canEnterNewPosition();

  if (!anyOpen && STATE.mode === 'live') {
    // 시장별 개장 예정 시각 표시
    const krMsg = (mkt === 'KR' || mkt === 'BOTH') ? `🇰🇷 ${getNextOpenStr('KR')}` : '';
    const usMsg = (mkt === 'US' || mkt === 'BOTH') ? `🇺🇸 ${getNextOpenStr('US')}` : '';
    const nextStr = [krMsg, usMsg].filter(Boolean).join(' | ');
    addLog('scan', `   ⏸️  장 외 시간 — 신규 진입 차단 (다음 개장: ${nextStr})`);
  } else if (blocked) {
    const who = preCloseKr && closingUs ? '국내(1h)+미국(30m)' : preCloseKr ? '국내 14:30~' : '미국 04:30~';
    addLog('scan', `   ⏰ [${who}] 마감 준비 — 신규 매수 차단, 청산 체크만 실행`);
  } else if (!canEnter && STATE.mode === 'live') {
    addLog('scan', `   ⏸️  진입 불가 — 장 외 또는 마감 임박`);
  } else if (STATE.positions.length < STATE.config.maxPositions) {
    await scanForEntries();
  } else {
    addLog('scan', `   📊 포지션 최대 (${STATE.positions.length}/${STATE.config.maxPositions}) — 진입 스킵`);
  }

  updateStatsUI();
  renderPositions();
}

// ─── 전략별 청산 파라미터 ────────────────────────────────────────
const EXIT_PARAMS = {
  // ⚡ 스캘핑: 빠른 익절·손절, 타이트한 트레일링
  scalping: {
    maxHoldSec:      1800,  // 최대 보유 30분 (기존 15분 → 여유 확보)
    trailTriggerMult: 1.0,
    trailDropPct:     0.4,
    slippagePct:      0.05,
    timeExitMinPnl:   0.1,
  },
  // 📊 거래량: 중간 트레일, 더 긴 보유
  volume: {
    maxHoldSec:      3600,  // 60분 (기존 30분)
    trailTriggerMult: 1.0,
    trailDropPct:     0.6,
    slippagePct:      0.08,
    timeExitMinPnl:   0.1,
  },
  // 🚀 모멘텀: 느슨한 트레일, 추세 타기
  momentum: {
    maxHoldSec:      7200,  // 120분 (기존 60분)
    trailTriggerMult: 1.2,
    trailDropPct:     1.0,
    slippagePct:      0.10,
    timeExitMinPnl:   0.0,
  },
  // ↩️ 평균회귀: 빠른 수익 확정, 반등 후 즉시 청산
  mean_reversion: {
    maxHoldSec:      14400, // 240분 (기존 120분)
    trailTriggerMult: 0.8,
    trailDropPct:     0.3,
    slippagePct:      0.12,
    timeExitMinPnl:   0.0,
  },
};

// 포지션 청산 체크 (전략별 트레일링 스탑 + 슬리피지 적용)
async function checkPositionsForExit() {
  const ep = EXIT_PARAMS[STATE.strategy] || EXIT_PARAMS.scalping;

  for (let i = STATE.positions.length - 1; i >= 0; i--) {
    const pos = STATE.positions[i];
    const isUs = pos.market === 'US';

    // ⚠️ 미국주식 장외시간/공휴일 매도 완전 차단 (실전 + 페이퍼 모두)
    // - 미국 정규장: 평일(공휴일 제외) 22:30~05:00 KST (서머타임 기준)
    // - 장외시간/공휴일에는 가격 갱신만 하고 매도 판단 전체 스킵
    // - 페이퍼 모드도 동일: 실제 체결 불가 시간에는 시뮬레이션도 차단
    if (isUs && !isUsMarketOpen()) {
      // 장외 차단 로그 (최초 1회만)
      if (!pos._offHoursLogged) {
        pos._offHoursLogged = true;
        const reason = isUsHoliday() ? '미국 공휴일' : '미국 장외시간';
        const modeTag = STATE.mode === 'paper' ? '[페이퍼]' : '[실전]';
        addLog('warn', `⏸️ ${modeTag} ${pos.name}(${pos.ticker}) — ${reason}: 매도 차단 (정규장 22:30 재개 시 자동 재개)`);
      }
      // 가격만 갱신 (PnL 추적용) — 장외시간에는 peakPnl을 0 이상으로만 유지
      const price = await fetchCurrentPrice(pos.ticker);
      if (price) {
        pos.currentPrice = price;
        pos.pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
        // ⚠️ 장외시간 peakPnl은 양수일 때만 갱신 — 음수 오염 방지
        if (pos.pnlPct > 0 && pos.pnlPct > (pos.peakPnl || 0)) pos.peakPnl = pos.pnlPct;
        // 기존에 음수로 오염된 peakPnl 복구
        if ((pos.peakPnl || 0) < 0) pos.peakPnl = 0;
      }
      continue; // 매도 판단 전체 스킵
    }
    // 장이 열렸으면 차단 로그 초기화
    if (isUs) pos._offHoursLogged = false;

    const currentPrice = await fetchCurrentPrice(pos.ticker);
    if (!currentPrice) continue;

    pos.currentPrice = currentPrice;
    const pnlPct    = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    pos.pnlPct      = pnlPct;

    // 고점 갱신 (peakPnl은 항상 0 이상 — 음수 오염 방지)
    if ((pos.peakPnl || 0) < 0) pos.peakPnl = 0; // 음수 복구
    if (pnlPct > (pos.peakPnl || 0)) pos.peakPnl = pnlPct;

    const holdSec   = (Date.now() - pos.entryTime) / 1000;
    const target    = STATE.config.profitTarget;
    const stopLoss  = STATE.config.stopLoss;

    // ── 마감 준비 구간: 완화된 청산 파라미터로 오버라이드 ──────────
    // 목적: 즉시 강제청산이 아니라 이익 극대화를 추구하면서 자연스럽게 청산
    //   - 손절: 기준 그대로 (손실 보호는 동일)
    //   - 트레일: 발동 기준 낮춤 → 작은 이익도 트레일 활성화
    //   - 트레일 낙폭: 좁힘 → 이익을 더 타이트하게 지킴
    //   - maxHoldSec: 0 → 진입 즉시 시간청산 조건 진입
    //     (이익>0이면 시간청산 수익 확정, 손실이면 손절로 처리)
    //   - timeExitMinPnl: 0 → 아주 작은 이익도 시간청산 허용
    const isKrPreClose = !isUs && STATE.mode === 'live' && isKrMarketPreClose();
    const isUsPreClose = isUs  && STATE.mode === 'live' && isUsMarketClosingSoon();
    const isPreCloseMode = isKrPreClose || isUsPreClose;

    const activeEp = isPreCloseMode ? {
      ...ep,
      // 트레일 발동 기준: 익절목표의 50%만 도달해도 트레일 활성화
      trailTriggerMult: Math.min(ep.trailTriggerMult, 0.5),
      // 트레일 낙폭 허용: 기존의 절반 → 이익을 타이트하게 지킴
      trailDropPct:     Math.max(ep.trailDropPct * 0.5, 0.2),
      // 최대 보유시간: 0초 → 이미 이익이면 바로 시간청산
      maxHoldSec:       0,
      // 최소 이익 기준: 0% → 아주 작은 이익도 수익 확정
      timeExitMinPnl:   0,
    } : ep;

    let exitReason = null;
    let exitType   = null; // 'profit' | 'loss' | 'trail' | 'time'

    // ── 1) 손절 ─────────────────────────────────────────────────
    // 🛡️ 손절 유예: 기존 보유 포지션이 이미 -stopLoss에 근접해 있으면
    //   0.5%p 추가 여유(effectiveStopLoss)를 줘서 반등 기회 부여
    //   단, 마감 준비 구간에서는 유예 없이 즉시 손절 (리스크 최소화)
    const stopLossBuffer = isPreCloseMode ? 0 : 0.5;
    const stopLossExtendThreshold = stopLoss * 0.8;
    const effectiveStopLoss =
      (!isPreCloseMode && !pos.stopLossExtended && pnlPct <= -stopLossExtendThreshold && pnlPct > -stopLoss)
        ? (() => {
            if (!pos._stopExtendLogged) {
              pos._stopExtendLogged = true;
              addLog('warn', `🛡️ 손절 유예: ${pos.name} ${pnlPct.toFixed(2)}% → 스탑 -${(stopLoss + stopLossBuffer).toFixed(1)}%까지 대기`);
            }
            pos.stopLossExtended = true;
            return stopLoss + stopLossBuffer;
          })()
        : pos.stopLossExtended && !isPreCloseMode
          ? stopLoss + stopLossBuffer
          : stopLoss;

    if (pnlPct <= -effectiveStopLoss) {
      exitReason = `손절 ${pnlPct.toFixed(2)}%${pos.stopLossExtended && !isPreCloseMode ? ` (유예 -${effectiveStopLoss.toFixed(1)}%)` : ''}`;
      exitType   = 'loss';
    }

    // ── 1-b) 부분 청산: 1차 목표 도달 시 50% 매도 + 나머지 트레일 ──
    // halfExited 플래그: false(미실행) → true(1차 50% 완료)
    // 조건: 목표가 × 0.6 이상 도달 & 아직 halfExited 아님 & 손절 아님
    // 마감 준비 구간에서는 부분 청산 없이 전량 청산으로 직행
    else if (!isPreCloseMode && !pos.halfExited && pnlPct >= target * 0.6) {
      const halfQty = Math.floor(pos.qty / 2);
      if (halfQty >= 1) {
        // 50% 수량 청산 실행
        const halfSlip   = activeEp.slippagePct;
        const halfNetPnl = pnlPct - 0.245 - halfSlip;
        addLog('scan', `   ✂️ 부분 청산(50%): ${pos.name} +${pnlPct.toFixed(2)}% (목표 ${(target*0.6).toFixed(2)}% 도달) → ${halfQty}주 청산`);

        // 부분 청산용 임시 pos 복사 (halfQty만)
        const halfPos = { ...pos, qty: halfQty };
        const halfOk  = await executeExit(halfPos, `1차 부분청산 +${pnlPct.toFixed(2)}%`, halfNetPnl, 'partial', halfSlip);

        if (halfOk) {
          pos.qty       -= halfQty;        // 남은 수량 = 원래 - halfQty
          pos.halfExited = true;            // 1차 부분청산 완료 플래그
          // 남은 수량에 대해 트레일 즉시 발동 (이미 목표에 도달했으므로)
          pos.trailArmed = true;
          addLog('scan', `   🔒 트레일 자동 발동: ${pos.name} 잔여 ${pos.qty}주 — 나머지 트레일 대기`);
          savePositions();
        }
      } else {
        // 수량 1주밖에 없으면 전량 트레일로 처리
        pos.trailArmed = true;
      }
    }

    // ── 2) 트레일링 스탑 ────────────────────────────────────────
    // 트레일 발동 조건: 익절목표 × activeEp.trailTriggerMult 최초 도달
    // 마감 준비 구간: 기준 낮춰 작은 이익에도 트레일 발동
    else if (pnlPct >= target * activeEp.trailTriggerMult) {
      if (!pos.trailArmed) {
        pos.trailArmed = true;
        const preTag = isPreCloseMode ? ' [마감준비]' : '';
        addLog('scan', `   🔒 트레일 발동${preTag}: ${pos.name} 고점 ${pos.peakPnl.toFixed(2)}% (기준 ${(target * activeEp.trailTriggerMult).toFixed(2)}% 돌파)`);
      }
      // 고점에서 activeEp.trailDropPct 이상 하락 시 청산
      // ⚠️ peakPnl이 음수로 오염된 경우 dropFromPeak가 음수가 되어 트레일 불발 → Max(0) 보정
      const dropFromPeak = Math.max(0, pos.peakPnl) - pnlPct;
      if (dropFromPeak >= activeEp.trailDropPct) {
        const preTag = isPreCloseMode ? ' [마감청산]' : '';
        exitReason = `트레일 청산${preTag} | 고점 +${pos.peakPnl.toFixed(2)}% → 현재 +${pnlPct.toFixed(2)}% (${dropFromPeak.toFixed(2)}%p 하락)`;
        exitType   = 'trail';
      }
    }

    // ── 3) 단순 익절 (트레일 미발동 상태에서 목표 도달) ──────────
    // 트레일 발동 전이고 목표 도달: 트레일 준비 (즉시 청산 안 함)
    // → 위 2번 조건에서 trailArmed가 설정됨

    // ── 4) 시간 청산 ────────────────────────────────────────────
    // ✅ else if 체인 밖으로 독립 — 트레일 발동 중에도 시간청산 적용
    // (trailArmed 중에도 maxHoldSec 초과 시 청산해야 장기 표류 방지)
    // 단, 이미 다른 exitReason이 설정된 경우엔 패스
    if (!exitReason && holdSec >= activeEp.maxHoldSec) {
      if (pnlPct > activeEp.timeExitMinPnl) {
        const preTag = isPreCloseMode ? ' [마감준비]' : '';
        exitReason = `시간청산${preTag} (${Math.round(holdSec/60)}분) +${pnlPct.toFixed(2)}%`;
        exitType   = 'time';
      } else if (!isPreCloseMode && pnlPct <= 0) {
        // 일반 시간 초과 + 손실: 손실 최소화 청산
        exitReason = `시간초과 청산 (${Math.round(holdSec/60)}분) ${pnlPct.toFixed(2)}%`;
        exitType   = 'time';
      }
      // 마감 준비 구간 + 손실 중: 손절 조건(1번)에서 처리 → 여기선 패스
    }

    if (exitReason) {
      // 슬리피지 적용: 시장가 매도 시 불리하게 체결
      const slippage  = activeEp.slippagePct;
      const netPnlPct = pnlPct - 0.245 - slippage; // 수수료 + 슬리피지 차감
      const exitOk = await executeExit(pos, exitReason, netPnlPct, exitType, slippage);
      // ✅ 실전: API 매도 성공(exitOk=true) 시에만 포지션 제거
      // ✅ 페이퍼: 항상 포지션 제거
      if (exitOk) {
        STATE.positions.splice(i, 1);
        savePositions(); // 청산 즉시 localStorage 갱신
      }
    }   // end if (exitReason)
  }     // end for loop
}       // end checkPositionsForExit

async function executeExit(pos, reason, netPnlPct, exitType, slippagePct) {
  const slip = slippagePct || 0.05;
  const isUs = pos.market === 'US';
  // 슬리피지 적용 체결가
  // ⚠️ 미국주식 매도 지정가 즉시체결 원리:
  //   - KIS 미국주식은 ORD_DVSN=00(지정가)만 지원 (정규장 기준)
  //   - 매도 지정가 ≤ 현재 매수호가 → 즉시 체결
  //   - 매도 지정가 > 현재 매수호가 → 미체결 대기 (이게 문제였음!)
  //   - 따라서 현재가보다 낮게 설정해야 즉시 체결됨
  //   - 미국주식은 슬리피지를 더 크게(0.1%) 설정해서 반드시 즉시 체결 보장
  const usExitSlip = Math.max(slip, 0.5); // 미국주식 매도 최소 슬리피지 0.5% → 즉시체결 보장
  const actualExitPrice = isUs
    ? Math.round(pos.currentPrice * (1 - usExitSlip / 100) * 100) / 100  // 달러: 현재가보다 낮은 지정가 (즉시체결)
    : Math.round(pos.currentPrice * (1 - slip / 100));              // 원화 정수
  const investAmt  = pos.entryPrice * pos.qty;
  const profitAmt  = Math.round(investAmt * netPnlPct / 100);
  const isWin      = netPnlPct > 0;

  if (STATE.mode === 'live') {
    try {
      if (isUs) {
        // 미국주식 매도
        // pos.excd 우선, 없으면 함수로 추론 → NASD/NYSE 정규화
        const rawExcd = pos.excd || getUsExchangeCode(pos.ticker);
        const excd = (rawExcd === 'NAS' || rawExcd === 'NASD') ? 'NASD' : 'NYSE';
        const res = await fetch('/api/kis/us/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appKey: KEYS.appKey, appSecret: KEYS.appSecret, accountNo: KEYS.accountNo,
            kisToken: getCachedKisToken(),
            symbol: pos.ticker, excd,
            side: 'sell', qty: pos.qty,
            price: actualExitPrice.toFixed(2), // 달러 지정가 (현재가 이하 → 즉시체결)
          }),
        });
        const data = await res.json();
        if (data.serverBlocked) { addLog('warn', `⚠️ 미국 매도 서버 차단: ${pos.ticker} — 포지션 유지`); return false; }
        // 서버 장외시간 차단 응답 → 포지션 유지 (조용히 처리, warn 로그만)
        if (data.offHours) {
          if (!pos._offHoursLogged) {
            pos._offHoursLogged = true;
            addLog('warn', `⏸️ [서버] 미국 장외시간 — ${pos.ticker} 매도 차단, 정규장(22:30) 재개 시 자동 처리`);
          }
          return false;
        }
        if (!data.ok) {
          const errMsg = data.error || JSON.stringify(data);
          // "주문수량이 가능수량보다 큽니다" = KIS에 이미 매도 접수됨 → 포지션 강제 제거
          if (errMsg.includes('가능수량') || errMsg.includes('주문수량')) {
            addLog('warn', `⚠️ ${pos.ticker} 미국 매도 — KIS 이미 접수된 것으로 간주 (가능수량 초과) → 포지션 제거`);
            // throw 없이 아래 성공 로직으로 넘어가게 처리
          } else {
            const detail = data.trId ? ` [trId:${data.trId} excd:${data.exchCd} hhmm:${data.hhmm}]` : '';
            throw new Error(errMsg + detail);
          }
        } else if (data.odnoMissing) {
          addLog('warn', `⚠️ ${pos.ticker} 미국 매도 ordNo 없음 — 매도 접수 성공 간주, KIS HTS에서 확인 필요`);
        } else {
          addLog('info', `📤 미국 매도접수: ${pos.ticker} ${pos.qty}주 @$${actualExitPrice.toFixed(2)} (지정가) [ordNo:${data.ordNo} trId:${data.trId}]`);
        }
        if (data.ordNo) {
          const _ordNo = data.ordNo, _ticker = pos.ticker;
          setTimeout(() => checkFillStatus('US', _ordNo, _ticker, 'sell'), 3000);
        }
      } else {
        // 국내주식 매도
        const res = await fetch('/api/kis/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appKey: KEYS.appKey, appSecret: KEYS.appSecret, accountNo: KEYS.accountNo,
            kisToken: getCachedKisToken(),
            ticker: pos.ticker, side: 'sell', qty: pos.qty,
          }),
        });
        const data = await res.json();
        if (data.serverBlocked) { addLog('warn', `⚠️ 국내 매도 서버 차단: ${pos.ticker} — ${data.error||'네트워크 오류'} — 포지션 유지`); return false; }
        if (!data.ok) {
          const errMsg = data.error || JSON.stringify(data);
          // "주문수량이 가능수량보다 큽니다" = KIS에 이미 매도 접수됨 → 포지션 강제 제거
          if (errMsg.includes('가능수량') || errMsg.includes('주문수량')) {
            addLog('warn', `⚠️ ${pos.ticker} 국내 매도 — KIS 이미 접수된 것으로 간주 (가능수량 초과) → 포지션 제거`);
          } else {
            const hint   = data.hint   ? ` → ${data.hint}`   : '';
            const rtCd   = data.rtCd   ? ` [rt_cd:${data.rtCd}]` : '';
            const trInfo = data.trId   ? ` [trId:${data.trId}]`  : '';
            throw new Error(errMsg + rtCd + trInfo + hint);
          }
        } else if (data.odnoMissing) {
          addLog('warn', `⚠️ ${pos.ticker} 국내 매도 ordNo 없음 — 매도 접수 성공 간주, KIS HTS에서 확인 필요`);
        } else {
          addLog('info', `📤 국내 매도접수: ${pos.ticker} ${pos.qty}주 (시장가) [ordNo:${data.ordNo} trId:TTTC0801U]`);
        }
        if (data.ordNo) {
          const _ordNo = data.ordNo, _ticker = pos.ticker;
          setTimeout(() => checkFillStatus('KR', _ordNo, _ticker, 'sell'), 3000);
        }
      }
    } catch(e) {
      addLog('error', `❌ 매도 실패: ${pos.ticker} — ${e.message}`);
      return false; // ← 매도 API 실패: false 반환 → 포지션 유지
    }
    // ── 실전: 매도 성공 → liveBalance 즉시 복원 (매도대금 반영) ──
    // profitAmt는 원화 기준 손익, investAmt = entryPrice * qty (원화 환산)
    const investAmtKrw = isUs ? Math.round(pos.entryPrice * pos.qty * STATE.usdKrw) : Math.round(pos.entryPrice * pos.qty);
    const profitAmtKrw2 = isUs ? Math.round(profitAmt * STATE.usdKrw) : profitAmt;
    const returnAmt = investAmtKrw + profitAmtKrw2;
    STATE.liveBalance         += returnAmt;
    STATE.liveBalanceKrwForUs += returnAmt;
    // ── liveTotalAsset 즉시 갱신: 매도손익 반영 (현금+주식 합계 변화) ──
    if (STATE.liveTotalAsset > 0) {
      const profitAmtKrw3 = isUs ? Math.round(profitAmt * STATE.usdKrw) : profitAmt;
      STATE.liveTotalAsset += profitAmtKrw3; // 손익만큼 총자산 변동 (원금은 현금↔주식 이동이라 중립)
    }
  } else {
    // 페이퍼: 현금 반환 (국내·미국 모두 원화)
    STATE.paperBalance += Math.round(investAmt + profitAmt);
  }

  STATE.stats.totalTrades++;
  if (isWin) STATE.stats.winTrades++;

  // 손익 원화 환산 (미국주식은 달러→원화 환산)
  const profitAmtKrw = isUs ? Math.round(profitAmt * STATE.usdKrw) : profitAmt;
  STATE.stats.totalProfit += profitAmtKrw;
  STATE.stats.dailyProfit += profitAmtKrw;

  STATE.profitHistory.push({ time: new Date().toLocaleTimeString('ko-KR', {hour:'2-digit',minute:'2-digit'}), cumProfit: STATE.stats.totalProfit });
  updateProfitChart();

  const icon  = isWin ? '✅' : '🚨';
  const color = isWin ? 'profit' : 'loss';
  const typeLabel = { profit: '익절', loss: '손절', trail: '트레일', time: '시간청산', close_eod: '장마감청산' }[exitType] || '청산';
  const mktFlag = isUs ? '🇺🇸' : '🇰🇷';
  const priceStr = isUs
    ? `$${pos.entryPrice.toFixed(2)} → $${actualExitPrice.toFixed(2)}`
    : `${fmtPrice(pos.entryPrice)} → ${fmtPrice(actualExitPrice)}`;
  const profitStr = isUs
    ? `$${(investAmt * netPnlPct / 100).toFixed(2)} (≈${fmtPrice(profitAmtKrw)}원)`
    : `${profitAmtKrw > 0 ? '+' : ''}${fmtPrice(profitAmtKrw)}원`;

  addLog(color, `${icon} ${mktFlag} [${typeLabel}] ${pos.name || pos.ticker} — ${reason}`);
  addLog(color, `   진입 ${priceStr} (슬리피지 -${slip}%)`);
  addLog(color, `   고점 +${(pos.peakPnl||0).toFixed(2)}% | 순손익 ${profitStr} (${netPnlPct > 0 ? '+' : ''}${netPnlPct.toFixed(2)}%)`);

  await recordTrade({
    ticker: pos.ticker, name: pos.name || pos.ticker,
    side: 'sell', entryPrice: pos.entryPrice, exitPrice: actualExitPrice,
    qty: pos.qty, pnlPct: netPnlPct, profitAmt: profitAmtKrw,
    peakPnl: pos.peakPnl || 0, slippage: slip, exitType, reason,
    timestamp: new Date().toISOString(), mode: STATE.mode, market: pos.market || 'KR',
    usdKrw: isUs ? STATE.usdKrw : 1,
  });
  await loadTradeHistory();

  STATE.recentResults.push({
    win:      isWin,
    pnlPct:   netPnlPct,
    pnlAmt:   profitAmtKrw,                          // 원화 손익금 (리포트용)
    entryAmt: Math.round(pos.qty * pos.entryPrice),   // 투자금액 (리포트 폴백용)
    ticker:   pos.ticker,
    name:     pos.name || pos.ticker,
    market:   pos.market || 'KR',
    closedAt: Date.now(),                             // 청산 시각 (오늘 거래 필터용)
  });
  if (STATE.recentResults.length > 30) STATE.recentResults.shift(); // 최대 30회 보관
  calcAdaptiveMode(); // 10회 단위 평가
  saveStats(); // #6 stats localStorage 저장 (Kelly 세션 간 연속성)

  // #4 잔고 자동 동기화: 실전 매도 성공 → 8초 후 실제 잔고 재조회
  if (STATE.mode === 'live' && KEYS.appKey) {
    setTimeout(async () => {
      if (STATE.liveBalanceFetching) return;
      STATE.liveBalanceFetching = true;
      try {
        const result = await getLiveBalance();
        const bal = result?.balance ?? result ?? 0;
        if (bal > 0) {
          STATE.liveBalance         = bal;
          STATE.liveBalanceKrwForUs = bal;
          STATE.liveBalanceTs       = Date.now();
          addLog('info', `💰 매도 후 잔고 동기화: ${fmtPrice(bal)}원`);
          updateStatsUI();
        }
      } catch(e) { /* 무시 */ } finally {
        STATE.liveBalanceFetching = false;
        STATE.liveBalanceTs = Date.now();
      }
    }, 8000);
  }

  return true; // ✅ 청산 완전 성공
}

// 신규 진입 스캔
async function scanForEntries() {
  const mkt = STATE.market;
  const isPaper = STATE.mode === 'paper';
  let candidates = [];

  if (mkt === 'KR') {
    // 국내만 — 14:30 이후 신규 매수 차단
    if ((isKrMarketOpen() && !isKrMarketPreClose()) || isPaper) {
      candidates = await generateKrCandidates();
    }
  } else if (mkt === 'US') {
    // 미국만 — 마감 30분 전 신규 매수 차단
    if ((isUsMarketOpen() && !isUsMarketClosingSoon()) || isPaper) {
      candidates = await generateUsCandidates();
    }
  } else { // BOTH — 국내/미국 각 100% 독립 (시간대 다름, 자본 분리 불필요)
    const maxPos = STATE.config.maxPositions;
    const krPosCount = STATE.positions.filter(p => p.market !== 'US').length;
    const usPosCount = STATE.positions.filter(p => p.market === 'US').length;

    // 국내: 14:30 이후 신규 매수 차단
    if (((isKrMarketOpen() && !isKrMarketPreClose()) || isPaper) && krPosCount < maxPos) {
      const krCands = await generateKrCandidates();
      candidates.push(...krCands.slice(0, maxPos - krPosCount));
    }
    // 미국: 마감 30분 전 신규 매수 차단
    if (((isUsMarketOpen() && !isUsMarketClosingSoon()) || isPaper) && usPosCount < maxPos) {
      const usCands = await generateUsCandidates();
      candidates.push(...usCands.slice(0, maxPos - usPosCount));
    }
  }

  STATE.candidates = candidates;
  addLog('scan', `   후보 ${candidates.length}개 발견 (${mkt})`);
  let orderCount = 0;
  for (const c of candidates) {
    if (STATE.positions.length >= STATE.config.maxPositions) break;
    if (STATE.positions.find(p => p.ticker === c.ticker)) continue;
    if (STATE._pendingTickers.has(c.ticker)) continue; // 주문 진행 중 중복 방지
    // KIS Rate Limit: 주문 간 1.2초 딜레이 (초당 거래건수 초과 방지)
    if (orderCount > 0) await new Promise(r => setTimeout(r, 1200));
    await executeEntry(c);
    orderCount++;
  }
}

// ─── 국내주식 후보 종목 스캔 ─────────────────────────────────
async function generateKrCandidates() {
  const strategy = document.getElementById('strategy-select').value || STATE.strategy;
  const ap = (ADAPTIVE_PARAMS[strategy] || ADAPTIVE_PARAMS.scalping)[STATE.adaptiveMode];

  // ── Step 1: 거래량 순위 조회 (KOSPI + KOSDAQ 병렬) ──────────────
  let rankStocks = [];
  try {
    const [kospiRes, kosdaqRes] = await Promise.allSettled([
      axios.get('/api/naver/volume-rank?market=KOSPI&top=30',  { timeout: 10000 }),
      axios.get('/api/naver/volume-rank?market=KOSDAQ&top=30', { timeout: 10000 }),
    ]);
    const kospiList  = kospiRes.status  === 'fulfilled' ? (kospiRes.value.data?.stocks  || []) : [];
    const kosdaqList = kosdaqRes.status === 'fulfilled' ? (kosdaqRes.value.data?.stocks || []) : [];
    if (kospiList.length === 0 && kosdaqList.length === 0) {
      addLog('warn', '⚠️ 거래량 순위 조회 실패 — 시뮬레이션 사용');
      return generateSimCandidates(strategy);
    }
    // 중복 제거 후 병합 (code 기준)
    const seen = new Set();
    for (const s of [...kospiList, ...kosdaqList]) {
      if (!seen.has(s.code)) { seen.add(s.code); rankStocks.push(s); }
    }
    addLog('scan', `   🇰🇷 거래량 순위: KOSPI ${kospiList.length}개 + KOSDAQ ${kosdaqList.length}개 → 병합 ${rankStocks.length}개`);
  } catch(e) {
    addLog('warn', '⚠️ 거래량 순위 조회 실패 — 시뮬레이션 사용');
    return generateSimCandidates(strategy);
  }

  if (rankStocks.length === 0) return generateSimCandidates(strategy);

  // ── Step 2: 전략별 1차 필터 (등락률 기준) ───────────────────────
  const preFiltered = rankStocks.filter(item => {
    const pct = item.changeRate;
    if (strategy === 'scalping')       return pct > ap.pctMin && pct < ap.pctMax;
    if (strategy === 'volume')         return pct > 0;
    if (strategy === 'momentum')       return pct > ap.pctMin;
    if (strategy === 'mean_reversion') return pct < ap.pctMin;
    return true;
  });

  // 필터 통과 0개이면 원본 전체 사용 (빈 결과 방지)
  const candPool = preFiltered.length > 0 ? preFiltered : rankStocks;

  // ── Step 3: 일봉 데이터 병렬 조회 (최대 15개, 타임아웃 8초) ──────
  // 네이버 fchart API → closes/highs/lows/volumes 추출
  const TOP_N = Math.min(candPool.length, 15);
  const candleResults = await Promise.allSettled(
    candPool.slice(0, TOP_N).map(async item => {
      try {
        const r = await axios.get(`/api/naver/candles/${item.code}?count=40`, { timeout: 8000 });
        const candles = r.data?.candles || [];
        if (candles.length < 10) return null; // 데이터 부족 → 스킵
        const closes  = candles.map(c => c.close);
        const highs   = candles.map(c => c.high  || c.close);
        const lows    = candles.map(c => c.low   || c.close);
        const volumes = candles.map(c => c.volume || 0);
        return { item, closes, highs, lows, volumes };
      } catch(e2) {
        return null;
      }
    })
  );

  // ── Step 4: calcSignalScore()로 실제 점수 계산 ───────────────────
  const scored = [];
  let withCandle = 0, withoutCandle = 0;

  for (const res of candleResults) {
    const data = res.status === 'fulfilled' ? res.value : null;
    if (data) {
      // 일봉 데이터 있음 → RSI/MACD/볼린저/거래량 기반 실제 점수
      const sig = calcSignalScore(data.closes, data.highs, data.lows, data.volumes, strategy, ap);
      withCandle++;
      // 전략 최소 점수 미달 → 스킵
      const minScore = ap.scoreBonus >= 0 ? 45 : 35;
      if (sig.score < minScore && strategy !== 'mean_reversion') continue;
      scored.push({
        ticker:    data.item.code,
        name:      data.item.name,
        price:     data.item.price,
        pctChange: data.item.changeRate,
        volume:    data.item.volume || data.volumes[data.volumes.length - 1] || 0,
        score:     sig.score,  // scoreBonus는 calcSignalScore() 내부에서 이미 반영됨 (이중 가산 방지)
        rsi:       sig.rsi,
        macdHist:  sig.macd.hist,
        bollPct:   sig.boll.pct,
        volMult:   sig.volMult,
      });
    } else {
      // 일봉 조회 실패 → 등락률 기반 폴백 점수 (고정 50 + α)
      // candPool에서 인덱스 역추적은 어려우므로 scored에 직접 추가 안 함
      withoutCandle++;
    }
  }

  addLog('scan', `   🇰🇷 일봉 RSI/MACD 계산: ${withCandle}개 성공, ${withoutCandle}개 실패`);

  // ── Step 5: 점수 내림차순 정렬 → 상위 N개 반환 (maxPositions 연동) ──────────────────
  // 슬롯 여유 = maxPositions - 현재 보유 수 (최소 3, 최대 10)
  const slotsLeft = Math.max(3, STATE.config.maxPositions - STATE.positions.length);
  const topN = Math.min(slotsLeft, scored.length);
  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    const top5 = scored.slice(0, topN);
    const topStr = top5.slice(0, 3).map(c =>
      `${c.name}(${c.score}점,RSI:${c.rsi?.toFixed(0)||'-'})`
    ).join(', ');
    addLog('scan', `   🇰🇷 국내 후보 ${top5.length}개 [실RSI/MACD] — ${topStr}`);
    return top5;
  }

  // 일봉 점수 기반 후보 없음 → 등락률 기반 폴백
  addLog('warn', '⚠️ 일봉 점수 기반 후보 없음 — 등락률 폴백 사용');
  const fallback = candPool.slice(0, slotsLeft).map(item => ({
    ticker:    item.code,
    name:      item.name,
    price:     item.price,
    pctChange: item.changeRate,
    volume:    item.volume || 0,
    score:     Math.min(100, Math.max(40, 50 + (item.changeRate || 0) * 5 + ap.scoreBonus)),
  }));
  return fallback;
}

function generateSimCandidates(strategy) {
  const STOCKS = [
    { ticker: '005930', name: '삼성전자',        basePrice: 78000 },
    { ticker: '000660', name: 'SK하이닉스',      basePrice: 195000 },
    { ticker: '035420', name: 'NAVER',           basePrice: 235000 },
    { ticker: '005380', name: '현대차',          basePrice: 265000 },
    { ticker: '051910', name: 'LG화학',          basePrice: 380000 },
    { ticker: '006400', name: '삼성SDI',         basePrice: 370000 },
    { ticker: '035720', name: '카카오',          basePrice: 48000 },
    { ticker: '068270', name: '셀트리온',        basePrice: 195000 },
    { ticker: '207940', name: '삼성바이오로직스', basePrice: 980000 },
    { ticker: '003670', name: '포스코홀딩스',    basePrice: 375000 },
  ];

  // 현재 적응 단계 파라미터 가져오기
  const ap = (ADAPTIVE_PARAMS[strategy] || ADAPTIVE_PARAMS.scalping)[STATE.adaptiveMode];

  const results = [];
  const shuffled = [...STOCKS].sort(() => Math.random() - 0.5);

  for (const s of shuffled.slice(0, 8)) {
    const pctChange   = (Math.random() - 0.3) * 4;
    const volMult     = 1 + Math.random() * 3;
    const rsi         = 30 + Math.random() * 50;
    const buyPressure = 0.8 + Math.random() * 0.8;

    let pass = false;
    if (strategy === 'scalping') {
      // 적응형 RSI/거래량/가격변동/매수압력 조건 적용
      pass = pctChange > ap.pctMin && pctChange < ap.pctMax
          && rsi > ap.rsiMin && rsi < ap.rsiMax
          && volMult >= ap.volMult
          && buyPressure >= ap.buyPressure;
    } else if (strategy === 'volume') {
      pass = volMult >= ap.volMult && pctChange > ap.pctMin && rsi < (ap.rsiMax || 70);
    } else if (strategy === 'momentum') {
      pass = pctChange > ap.pctMin && volMult >= ap.volMult;
    } else if (strategy === 'mean_reversion') {
      pass = pctChange < ap.pctMin && rsi < (ap.rsiMax || 30);
    }

    if (pass) {
      const price = s.basePrice * (1 + pctChange / 100);
      // 적응 단계에 따른 score 보정
      const baseScore = Math.round(50 + Math.random() * 40);
      results.push({
        ticker:      s.ticker,
        name:        s.name,
        price:       Math.round(price),
        pctChange:   parseFloat(pctChange.toFixed(2)),
        volume:      Math.round(1000000 * volMult),
        rsi:         parseFloat(rsi.toFixed(1)),
        buyPressure: parseFloat(buyPressure.toFixed(2)),
        score:       Math.min(100, Math.max(0, baseScore + (ap.scoreBonus || 0))),
      });
    }
  }
  return results;
}

// ─── 미국주식 후보 종목 스캔 ─────────────────────────────────
async function generateUsCandidates() {
  const strategy = document.getElementById('strategy-select').value || STATE.strategy;
  const ap = (ADAPTIVE_PARAMS[strategy] || ADAPTIVE_PARAMS.scalping)[STATE.adaptiveMode];

  // 나스닥 + NYSE 주요 종목 고정 리스트 (전체 조회)
  // KIS 초당 1회 Rate Limit → 서버에서 최대 10개까지만 처리 (10초 이내 완료)
  // 시가총액 상위 + 변동성 높은 종목 우선 선정
  const US_STOCKS = [
    // 나스닥 대형주 (변동성 높은 순)
    { ticker: 'NVDA',  name: 'NVIDIA',        excd: 'NAS' },
    { ticker: 'TSLA',  name: 'Tesla',         excd: 'NAS' },
    { ticker: 'AMD',   name: 'AMD',           excd: 'NAS' },
    { ticker: 'NFLX',  name: 'Netflix',       excd: 'NAS' },
    { ticker: 'META',  name: 'Meta',          excd: 'NAS' },
    { ticker: 'AMZN',  name: 'Amazon',        excd: 'NAS' },
    { ticker: 'AAPL',  name: 'Apple',         excd: 'NAS' },
    // NYSE 대형주
    { ticker: 'JPM',   name: 'JPMorgan',      excd: 'NYS' },
    { ticker: 'V',     name: 'Visa',          excd: 'NYS' },
    { ticker: 'XOM',   name: 'ExxonMobil',    excd: 'NYS' },
  ];  // 10개 고정 — KIS Rate Limit(초당 1회) 준수, 11초 내 완료

  // 실전 모드: KIS API 배치 엔드포인트로 1회 요청 (토큰 1회 발급 — 다중 발급 방지)
  if (STATE.mode === 'live' && KEYS.appKey) {
    try {
      // 20개 종목을 서버 1회 요청으로 처리 — 잔고도 함께 조회 (토큰 1회 발급으로 모두 처리)
      const res = await fetch('/api/kis/us/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appKey: KEYS.appKey, appSecret: KEYS.appSecret,
          symbols: US_STOCKS.map(s => ({ ticker: s.ticker, excd: s.excd })),
          accountNo: KEYS.accountNo || null, // 잔고 동시 조회 (토큰 추가 발급 없음)
        }),
        signal: AbortSignal.timeout(30000), // 10종목 × 1.1초 = ~12초, 여유 30초
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        addLog('warn', `⚠️ 미국주식 시세 배치 조회 실패 — ${data.error || res.status}`);
        // 배치 조회 실패해도 ts 갱신 → executeEntry에서 "미조회 상태" 무한 스킵 방지
        if (STATE.liveBalanceUsdTs === 0) STATE.liveBalanceUsdTs = Date.now();
        return generateUsSimCandidates(strategy, ap);
      }
      // ── 잔고 처리: 통합증거금 — 원화만 사용 (달러 불필요)
      // cashKrw > 0 이면 liveBalance 갱신, 0이면 manual_krw_balance 폴백
      if (data.balance) {
        const bal = data.balance;
        const krw = bal.cashKrw || 0;
        if (krw > 0) {
          STATE.liveBalance         = krw;
          STATE.liveBalanceTs       = Date.now();
          STATE.liveBalanceKrwForUs = krw;
          addLog('info', `💴 통합증거금 원화 잔고: ${fmtPrice(krw)}원`);
        } else {
          // 서버에서 원화 잔고 못 받음 → manual_krw_balance 폴백
          const manual = parseInt(localStorage.getItem('manual_krw_balance') || '0');
          if (manual > 0 && STATE.liveBalance <= 0) {
            STATE.liveBalance         = manual;
            STATE.liveBalanceTs       = Date.now();
            STATE.liveBalanceKrwForUs = manual;
          }
        }
        STATE.liveBalanceUsdTs = Date.now();
        updateStatsUI();
      } else {
        // 잔고 응답 없음 → manual_krw_balance 폴백
        const manual = parseInt(localStorage.getItem('manual_krw_balance') || '0');
        if (manual > 0 && STATE.liveBalance <= 0) {
          STATE.liveBalance         = manual;
          STATE.liveBalanceTs       = Date.now();
          STATE.liveBalanceKrwForUs = manual;
        }
        STATE.liveBalanceUsdTs = Date.now();
      }
      const rawResults = data.results || [];
      // US_STOCKS 메타(name) 병합
      const tickerMeta = {};
      US_STOCKS.forEach(s => { tickerMeta[s.ticker] = s; });
      const valid = rawResults
        .filter(r => r.price > 0)
        .map(r => ({ ...tickerMeta[r.ticker], price: r.price, pctChange: r.changeRate ?? 0, volume: r.volume ?? 0 }));
      addLog('scan', `   🇺🇸 미국주식 시세 조회: ${valid.length}/${US_STOCKS.length}개 성공`);

      if (valid.length > 0) {
        // ── 미국주식: 적응 모드보다 1단계 강화된 진입조건 적용 ───────────────
        // 한국주식보다 유동성·변동성 다름 → 더 엄격한 필터 적용
        // 현재 adaptiveMode가 0(공격)이면 1(기본) 조건 적용, 3(대기)이면 3 유지
        const usAdapMode = Math.min(STATE.adaptiveMode + 1, 3);
        const usAp = (ADAPTIVE_PARAMS[strategy] || ADAPTIVE_PARAMS.scalping)[usAdapMode];
        const volApStrat = ADAPTIVE_PARAMS.volume[usAdapMode];

        // 전략별 강화 조건 필터
        const usFiltered = valid.filter(item => {
          const pct = item.pctChange || 0;
          const vol = item.volume || 0;
          if (strategy === 'scalping') {
            // 스캘핑: 가격변동 범위 체크 (RSI/거래량은 KIS에서 안 옴 → pct만 체크)
            return pct >= usAp.pctMin && pct <= (usAp.pctMax || 5.0);
          } else if (strategy === 'volume') {
            // 거래량: 상승 중인 종목만 (pctMin 이상)
            return pct >= (volApStrat.pctMin || 0.3);
          } else if (strategy === 'momentum') {
            // 모멘텀: 강한 상승 종목만
            return pct >= usAp.pctMin;
          } else if (strategy === 'mean_reversion') {
            // 평균회귀: 충분히 하락한 종목
            return pct < -0.5;
          }
          return true;
        });

        addLog('scan', `   🇺🇸 강화조건(적응${usAdapMode}단계) 통과: ${usFiltered.length}/${valid.length}개`);

        // 필터 통과 없으면 조건 완화해서 재시도 (빈 결과 방지)
        const sortPool = usFiltered.length > 0 ? usFiltered : valid;

        let sorted;
        if (strategy === 'mean_reversion') {
          sorted = sortPool.filter(i => (i.pctChange || 0) < 0)
                           .sort((a, b) => (a.pctChange || 0) - (b.pctChange || 0));
          if (sorted.length === 0) sorted = sortPool.sort((a, b) => (a.pctChange || 0) - (b.pctChange || 0));
        } else if (strategy === 'momentum') {
          sorted = sortPool.sort((a, b) => (b.pctChange || 0) - (a.pctChange || 0));
        } else {
          sorted = sortPool.sort((a, b) => Math.abs(b.pctChange || 0) - Math.abs(a.pctChange || 0));
        }

        // ── 미국주식 동적 점수 계산 (일봉 없음 → 시세 데이터 기반) ──
        // 등락률·거래량·MA거리 등 현재 시세로 신호 점수 산출 (Math.random 제거)
        const allPcts   = valid.map(i => Math.abs(i.pctChange || 0));
        const avgPct    = allPcts.length ? allPcts.reduce((a,b)=>a+b,0)/allPcts.length : 1;
        const allVols   = valid.map(i => i.volume || 0);
        const avgVol    = allVols.length ? allVols.reduce((a,b)=>a+b,0)/allVols.length : 1;

        const usSlotsLeft = Math.max(3, STATE.config.maxPositions - STATE.positions.filter(p => p.market === 'US').length);
        const candidates = sorted.slice(0, usSlotsLeft).map(item => {
          const pct   = item.pctChange || 0;
          const vol   = item.volume || 0;
          let sc = 50; // 기준점

          if (strategy === 'scalping') {
            // 등락률 1~3% 구간: 매수 신호 가장 강함
            if (Math.abs(pct) >= 1.0 && Math.abs(pct) <= 3.0) sc += 15;
            else if (Math.abs(pct) > 3.0) sc -= 5;
            // 거래량 배수 (오늘 거래량 / 평균 거래량)
            const vMult = avgVol > 0 ? vol / avgVol : 1;
            if (vMult >= 1.5) sc += 12;
            else if (vMult >= 1.0) sc += 6;
            // 방향성 가중
            if (pct > 0) sc += 8;
          } else if (strategy === 'volume') {
            const vMult = avgVol > 0 ? vol / avgVol : 1;
            if (vMult >= 2.0) sc += 25;
            else if (vMult >= 1.5) sc += 15;
            if (pct > 0) sc += 10;
          } else if (strategy === 'momentum') {
            // 상위 등락률 가중
            const rank = sorted.indexOf(item);
            sc += Math.max(0, 20 - rank * 5);
            if (pct > 0) sc += 10;
          } else if (strategy === 'mean_reversion') {
            // 하락폭 클수록 반등 기대 → 높은 점수
            if (pct < -2.0) sc += 25;
            else if (pct < -1.0) sc += 15;
          }

          sc = Math.min(100, Math.max(0, Math.round(sc + (usAp.scoreBonus || 0))));
          return {
            ticker:    item.ticker,
            name:      item.name,
            price:     item.price,
            pctChange: pct,
            volume:    vol,
            score:     sc,
            market:    'US',
            excd:      item.excd,
          };
        });

        if (candidates.length > 0) {
          const topStr = candidates.slice(0,3).map(c => `${c.ticker}(${c.pctChange>0?'+':''}${(c.pctChange||0).toFixed(2)}%)`).join(', ');
          addLog('scan', `   🇺🇸 미국주식 후보 ${candidates.length}개 (강화조건 적용) — ${topStr}`);
          return candidates;
        }
      } else {
        addLog('warn', '⚠️ 미국주식 시세 전체 조회 실패 — 시뮬레이션 사용');
      }
    } catch(e) {
      addLog('warn', '⚠️ 미국주식 스캔 오류 — 시뮬레이션 사용: ' + (e?.message || ''));
      // catch 이후에도 ts 갱신 → "미조회 상태" 무한 스킵 방지
      if (STATE.liveBalanceUsdTs === 0) STATE.liveBalanceUsdTs = Date.now();
    }
  }

  // 페이퍼 모드 또는 API 실패: 시뮬레이션
  return generateUsSimCandidates(strategy, ap);
}

function generateUsSimCandidates(strategy, ap) {
  // 국내 generateSimCandidates와 동일 구조 — 엄격한 복합 조건 제거, 등락률 정렬로 대체
  const US_STOCKS = [
    { ticker: 'AAPL',  name: 'Apple',      basePrice: 228 },
    { ticker: 'MSFT',  name: 'Microsoft',  basePrice: 430 },
    { ticker: 'NVDA',  name: 'NVIDIA',     basePrice: 130 },
    { ticker: 'AMZN',  name: 'Amazon',     basePrice: 195 },
    { ticker: 'GOOGL', name: 'Alphabet',   basePrice: 175 },
    { ticker: 'META',  name: 'Meta',       basePrice: 560 },
    { ticker: 'TSLA',  name: 'Tesla',      basePrice: 250 },
    { ticker: 'AMD',   name: 'AMD',        basePrice: 145 },
    { ticker: 'JPM',   name: 'JPMorgan',   basePrice: 245 },
    { ticker: 'INTC',  name: 'Intel',      basePrice: 22  },
    { ticker: 'NFLX',  name: 'Netflix',    basePrice: 720 },
    { ticker: 'CRM',   name: 'Salesforce', basePrice: 310 },
  ];
  const adap = ap || (ADAPTIVE_PARAMS[strategy] || ADAPTIVE_PARAMS.scalping)[STATE.adaptiveMode];

  // 페이퍼 시뮬레이션: 고정 시드 기반 변동률 (Math.random 최소화)
  // 종목 고유 특성을 반영한 변동성 범위 (실제 베타 기반 근사)
  const BETA = { NVDA:1.8, TSLA:2.0, AMD:1.6, NFLX:1.3, META:1.2, AMZN:1.1,
                 AAPL:0.9, MSFT:0.8, GOOGL:1.0, JPM:0.9, INTC:1.1, CRM:1.0 };
  const now = Date.now();
  const simulated = US_STOCKS.map((s, idx) => {
    // 시간 + 종목 인덱스 기반 의사 랜덤 (같은 스캔에서 일관성 유지)
    const seed = ((now / 60000 | 0) + idx * 17) % 100;
    const beta = BETA[s.ticker] || 1.0;
    const pctChange = parseFloat((((seed / 100) - 0.4) * 4 * beta).toFixed(2));
    const price     = Math.round(s.basePrice * (1 + pctChange / 100) * 100) / 100;
    // 전략별 점수 계산 (Math.random 불필요)
    let sc = 50;
    if (strategy === 'scalping')       sc += Math.abs(pctChange) >= 1.0 && Math.abs(pctChange) <= 3.0 ? 20 : 5;
    else if (strategy === 'volume')    sc += beta >= 1.5 ? 20 : 10;
    else if (strategy === 'momentum')  sc += pctChange > 0 ? 20 : 0;
    else if (strategy === 'mean_reversion') sc += pctChange < -1.5 ? 25 : (pctChange < 0 ? 10 : 0);
    return {
      ticker:    s.ticker,
      name:      s.name,
      price,
      pctChange,
      score:     Math.min(100, Math.max(0, Math.round(sc + (adap.scoreBonus || 0)))),
      market:    'US',
    };
  });

  let sorted;
  if (strategy === 'mean_reversion') {
    sorted = simulated.sort((a, b) => a.pctChange - b.pctChange); // 하락 큰 순
  } else if (strategy === 'momentum') {
    sorted = simulated.sort((a, b) => b.pctChange - a.pctChange); // 상승 큰 순
  } else {
    sorted = simulated.sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange)); // 변동 큰 순
  }
  return sorted.slice(0, Math.max(3, STATE.config.maxPositions - STATE.positions.length));
}

// ─── 체결 확인 (국내: TTTC8001R / 미국: TTTS3035R) ──────────
/**
 * 매수/매도 접수 후 체결 상태 조회
 * @param {string}  market  'KR' | 'US'
 * @param {string}  ordNo   주문번호
 * @param {string}  ticker  종목코드
 * @param {string}  [side]  'buy'|'sell' — pending 처리 방향
 * @returns {Promise<{status:'filled'|'partial'|'pending'|'error', ccldQty, remainQty}>}
 */
async function checkFillStatus(market, ordNo, ticker, side = 'buy') {
  if (!KEYS.appKey || !KEYS.accountNo) return { status: 'error', reason: 'no-keys' };
  if (!ordNo) return { status: 'error', reason: 'no-ordNo' };

  try {
    const endpoint = market === 'US' ? '/api/kis/us/confirm' : '/api/kis/confirm';
    const body = {
      appKey:    KEYS.appKey,
      appSecret: KEYS.appSecret,
      accountNo: KEYS.accountNo,
      kisToken:  getCachedKisToken(),
      ordNo,
      ticker,
    };
    const res  = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!data.ok) {
      addLog('warn', `⚠️ 체결 확인 실패 [${market}] ordNo:${ordNo} — ${data.error || res.status}`);
      return { status: 'error', reason: data.error };
    }
    const filled = data.filled || {};
    const status = filled.status || 'pending';
    const ccldQty   = filled.ccldQty   || 0;
    const ccldPrice = filled.ccldPrice || 0; // 실제 체결단가 (KR: avg_prvs, US: ft_ccld_unpr3)
    addLog('scan', `   📋 체결확인 [${market}] ${ticker} ordNo:${ordNo} → ${status} (체결:${ccldQty}주, 잔여:${filled.remainQty||0}주${ccldPrice > 0 ? `, 체결단가:${market==='US' ? '$'+ccldPrice.toFixed(2) : fmtPrice(ccldPrice)+'원'}` : ''})`);

    // ✅ 체결가/수량 → pos.entryPrice / pos.qty 갱신 (진입가 괴리 수정)
    if (side === 'buy' && (status === 'filled' || status === 'partial') && ccldPrice > 0) {
      const pos = STATE.positions.find(p => p.ticker === ticker && p.market === market);
      if (pos) {
        const oldPrice = pos.entryPrice;
        const oldQty   = pos.qty;
        pos.entryPrice = ccldPrice;                               // 실제 체결단가로 교체
        if (ccldQty > 0 && ccldQty !== oldQty) pos.qty = ccldQty; // 실제 체결수량으로 교체
        pos.pnlPct = pos.currentPrice > 0
          ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
          : 0;
        // peakPnl은 이미 음수 보호 중이므로 pnlPct가 양수일 때만 갱신
        if (pos.pnlPct > (pos.peakPnl || 0)) pos.peakPnl = pos.pnlPct;
        savePositions();
        const priceStr = market === 'US'
          ? `$${oldPrice.toFixed(2)} → $${ccldPrice.toFixed(2)}`
          : `${fmtPrice(oldPrice)}원 → ${fmtPrice(ccldPrice)}원`;
        addLog('info', `🔄 진입가 갱신 [${market}] ${ticker}: ${priceStr} (실제 체결가 반영) PnL: ${pos.pnlPct.toFixed(2)}%`);
        renderPositions();
        updateStatsUI();
      }
    }

    // #5 미체결 처리: pending이면 10초 후 재확인 → 여전히 미체결이면 포지션 제거
    if (status === 'pending' && side === 'buy') {
      addLog('warn', `⏳ 미체결 감지 [${market}] ${ticker} — 10초 후 재확인 예정`);
      setTimeout(async () => {
        try {
          const res2 = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, kisToken: getCachedKisToken() }),
            signal: AbortSignal.timeout(8000),
          });
          const data2 = await res2.json();
          const filled2   = data2?.filled || {};
          const status2   = filled2.status   || 'pending';
          const ccldQty2  = filled2.ccldQty  || 0;
          const ccldPrice2 = filled2.ccldPrice || 0;
          addLog('scan', `   📋 재확인 [${market}] ${ticker} ordNo:${ordNo} → ${status2}${ccldPrice2 > 0 ? ` 체결단가:${market==='US' ? '$'+ccldPrice2.toFixed(2) : fmtPrice(ccldPrice2)+'원'}` : ''}`);

          // ✅ 재확인에서도 체결가 갱신
          if ((status2 === 'filled' || status2 === 'partial') && ccldPrice2 > 0) {
            const pos = STATE.positions.find(p => p.ticker === ticker && p.market === market);
            if (pos) {
              const oldPrice2 = pos.entryPrice;
              pos.entryPrice = ccldPrice2;
              if (ccldQty2 > 0 && ccldQty2 !== pos.qty) pos.qty = ccldQty2;
              pos.pnlPct = pos.currentPrice > 0
                ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
                : 0;
              if (pos.pnlPct > (pos.peakPnl || 0)) pos.peakPnl = pos.pnlPct;
              savePositions();
              addLog('info', `🔄 진입가 갱신(재확인) [${market}] ${ticker}: ${market==='US' ? '$'+oldPrice2.toFixed(2)+' → $'+ccldPrice2.toFixed(2) : fmtPrice(oldPrice2)+'원 → '+fmtPrice(ccldPrice2)+'원'} PnL: ${pos.pnlPct.toFixed(2)}%`);
              renderPositions();
              updateStatsUI();
            }
          }

          if (status2 === 'pending') {
            // 여전히 미체결 → 포지션 목록에서 제거 (미체결 매수는 실제로 보유 안 된 것)
            const idx = STATE.positions.findIndex(p => p.ticker === ticker && p.market === market);
            if (idx !== -1) {
              const pos = STATE.positions[idx];
              // 차감했던 잔고 복구
              const investAmt = Math.round(pos.qty * pos.entryPrice);
              if (market !== 'US') {
                STATE.liveBalance = (STATE.liveBalance || 0) + investAmt;
                STATE.liveBalanceKrwForUs = (STATE.liveBalanceKrwForUs || 0) + investAmt;
              }
              STATE.positions.splice(idx, 1);
              savePositions();
              addLog('warn', `🗑️ 미체결 포지션 제거 [${market}] ${ticker} — 잔고 ${fmtPrice(investAmt)}원 복구`);
              renderPositions();
              updateStatsUI();
            }
          } else if (status2 === 'filled' || status2 === 'partial') {
            addLog('info', `✅ 체결 확인 완료 [${market}] ${ticker}: ${status2} (${ccldQty2}주)`);
          }
        } catch(e2) {
          addLog('warn', `⚠️ 미체결 재확인 오류 [${market}] ${ticker} — ${e2?.message || e2}`);
        }
      }, 10000);
    }

    return { status, ccldQty, ccldPrice, remainQty: filled.remainQty || 0 };
  } catch(e) {
    // 체결확인 API 자체 오류 → 비중요(매도/매수 접수는 이미 성공) → warn만
    addLog('warn', `⚠️ 체결 확인 오류 [${market}] ordNo:${ordNo} — ${e?.message || e}`);
    return { status: 'error', reason: e?.message };
  }
}

// 매수 실행 (국내/미국 통합)
async function executeEntry(candidate) {
  const isUs = candidate.market === 'US';

  // ── 중복 주문 방지: 이미 진행 중인 ticker 즉시 차단 ──
  if (STATE._pendingTickers.has(candidate.ticker)) {
    addLog('warn', `⚠️ 중복 주문 차단: ${candidate.ticker} — 이미 주문 진행 중`);
    return;
  }
  // KIS 실제 보유 포지션 중복 체크 (loadPositions로 불러온 포지션 포함)
  if (STATE.positions.find(p => p.ticker === candidate.ticker)) {
    addLog('warn', `⚠️ 중복 주문 차단: ${candidate.ticker} — 이미 보유 중`);
    return;
  }
  STATE._pendingTickers.add(candidate.ticker); // 잠금

  try {
  // ── 가용 자금 조회 ─────────────────────────────────────
  let available;
  if (STATE.mode === 'paper') {
    // 페이퍼: 국내·미국 모두 원화 기준 (달러 시뮬레이션 제거)
    if (isUs && STATE.paperBalance <= 0 && STATE.config.paperCapital > 0) {
      STATE.paperBalance = STATE.config.paperCapital;
    }
    available = STATE.paperBalance;
  } else {
    // ── 실전: 통합증거금 — 원화 잔고만 사용 (달러 완전 불필요)
    // 우선순위: ① STATE.liveBalance ② manual_krw_balance(localStorage)
    const manualKrw = parseInt(localStorage.getItem('manual_krw_balance') || '0');
    if (STATE.liveBalance <= 0 && manualKrw > 0) {
      STATE.liveBalance         = manualKrw;
      STATE.liveBalanceTs       = Date.now();
      STATE.liveBalanceKrwForUs = manualKrw;
    }
    available = STATE.liveBalance;
    if (available <= 0) {
      // ✅ 잔고가 0이면 KIS 재조회 1회 시도 (장 개시 직후 일시적 0 케이스)
      addLog('info', `💰 실전 잔고 0 — KIS 재조회 시도 중...`);
      try {
        const freshResult = await getLiveBalance();
        const freshBal = freshResult?.balance ?? freshResult ?? 0;
        if (freshBal > 0) {
          STATE.liveBalance         = freshBal;
          STATE.liveBalanceKrwForUs = freshBal;
          STATE.liveBalanceTs       = Date.now();
          available = freshBal;
          addLog('info', `💰 잔고 재조회 성공: ${fmtPrice(freshBal)}원`);
        }
      } catch(e) { /* 무시 */ }
    }
    if (available <= 0) {
      if (!STATE._balWarnedOnce) {
        STATE._balWarnedOnce = true;
        addLog('warn', '⚠️ 실전 원화 잔고 없음 — 총자산 카드 ✏️ 버튼으로 잔고를 입력하세요');
        openBalanceInput();
      }
      return;
    }
  }
  STATE._balWarnedOnce = false;
  if (available < 10000) {
    addLog('warn', `⚠️ 가용 자금 부족: ${fmtPrice(available)}원`);
    return;
  }

  // ── 포지션 금액 계산 (켈리 공식 Half-Kelly) ──────────────────
  const posMin     = STATE.config.posMinAmt  || 50000;
  const posMaxBase = STATE.config.posMaxAmt  || 150000;
  if (available < posMin) {
    addLog('warn', `⚠️ 가용 현금 부족 (${fmtManwon(available)} < 최소 ${fmtManwon(posMin)})`);
    return;
  }

  // 최근 거래 승률 및 평균 손익 계산
  const totalTrades  = STATE.stats.totalTrades || 0;
  const winTrades    = STATE.stats.winTrades   || 0;
  const winRate      = totalTrades > 0 ? winTrades / totalTrades : 0.5;
  const { avgWin, avgLoss } = calcAvgWinLoss();
  const drawdownFactor      = calcDrawdownFactor();

  // 켈리 공식으로 포지션 금액 산출
  const kellyAmt = calcKellyPositionSize(winRate, avgWin, avgLoss, available, STATE.config);
  const investAmt = kellyAmt;
  if (investAmt < 10000) return;

  // 켈리 진단 로그 (거래 5회 이상 시 상세 출력)
  if (totalTrades >= 5) {
    const mktF = isUs ? '🇺🇸' : '🇰🇷';
    addLog('scan', `   ${mktF} Kelly: 승률${(winRate*100).toFixed(0)}% W:${avgWin.toFixed(2)}% L:${avgLoss.toFixed(2)}% × 드로우다운×${drawdownFactor} → ${fmtManwon(investAmt)}`);
  }

  // 수량 계산
  const price = candidate.price || 1;
  const qty   = isUs
    ? Math.floor((investAmt / STATE.usdKrw) / price * 100) / 100 // 달러 수량 (소수점 가능)
    : Math.floor(investAmt / price);
  const qtyInt = Math.floor(qty); // 미국도 정수 수량 (KIS API 제약)
  if (qtyInt < 1) { addLog('warn', `⚠️ 수량 부족: ${candidate.ticker} $${price} — 최소 1주 필요`); return; }

  // ── 실전 주문 실행 ─────────────────────────────────────
  if (STATE.mode === 'live') {
    try {
      if (isUs) {
        // candidate.excd(NAS/NYS) 우선, 없으면 함수로 추론 → NASD/NYSE 정규화
        const rawExcd = candidate.excd || getUsExchangeCode(candidate.ticker);
        const excd = (rawExcd === 'NAS' || rawExcd === 'NASD') ? 'NASD' : 'NYSE';
        const res = await fetch('/api/kis/us/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appKey: KEYS.appKey, appSecret: KEYS.appSecret, accountNo: KEYS.accountNo,
            kisToken: getCachedKisToken(),
            symbol: candidate.ticker, excd,
            side: 'buy', qty: qtyInt,
            price: price.toFixed(2), // 지정가 (달러, 소수점 2자리)
          }),
        });
        const data = await res.json();
        if (data.serverBlocked) { addLog('warn', `⚠️ 미국 매수 서버 차단: ${candidate.ticker}`); return; }
        if (!data.ok) {
          const errMsg = data.error || JSON.stringify(data);
          const hint   = data.hint   ? ` → ${data.hint}` : '';
          const detail = data.trId ? ` [trId:${data.trId} excd:${data.exchCd} hhmm:${data.hhmm}]` : '';
          // "주문수량이 가능수량보다 큽니다" = 잔고 부족 → 친절한 메시지로 개선 (포지션 추가 안 함 — throw 유지)
          if (errMsg.includes('가능수량') || errMsg.includes('주문수량')) {
            throw new Error(`❌ 미국 매수 거부 — 잔고 부족 (주문수량 > 가능수량). 투자금액 설정을 낮추거나 잔고를 확인하세요${detail}`);
          }
          throw new Error(errMsg + detail + hint);
        }
        // ✅ ordNo 로깅 — 실제 주문번호 확인용 (없어도 rt_cd=0이면 접수된 것으로 처리)
        addLog('info', `📥 미국 매수접수: ${candidate.ticker} ${qtyInt}주 @$${price.toFixed(2)} [ordNo:${data.ordNo||'없음'} trId:${data.trId||''}]`);
        if (data.odnoMissing) addLog('warn', `⚠️ ${candidate.ticker} 매수 ordNo 없음 — KIS 야간/시간외 접수 케이스. HTS에서 확인 필요`);
        // 🔍 3초 후 체결 확인 (비동기 — 메인 흐름 블록 안 함)
        if (data.ordNo) {
          const _ordNo = data.ordNo, _ticker = candidate.ticker;
          setTimeout(() => checkFillStatus('US', _ordNo, _ticker), 3000);
        }
      } else {
        const res = await fetch('/api/kis/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appKey: KEYS.appKey, appSecret: KEYS.appSecret, accountNo: KEYS.accountNo,
            kisToken: getCachedKisToken(),
            ticker: candidate.ticker, side: 'buy', qty: qtyInt,
          }),
        });
        const data = await res.json();
        if (data.serverBlocked) { addLog('warn', `⚠️ 국내 매수 서버 차단: ${candidate.ticker} — ${data.error || '네트워크 오류'}`); return; }
        if (!data.ok) {
          const errMsg = data.error || JSON.stringify(data);
          const hint   = data.hint   ? ` → ${data.hint}`   : '';
          const rtCd   = data.rtCd   ? ` [rt_cd:${data.rtCd}]` : '';
          const trInfo = data.trId   ? ` [trId:${data.trId}]`  : '';
          // "주문수량이 가능수량보다 큽니다" = 잔고 부족 → 친절한 메시지로 개선 (포지션 추가 안 함 — throw 유지)
          if (errMsg.includes('가능수량') || errMsg.includes('주문수량')) {
            throw new Error(`❌ 국내 매수 거부 — 잔고 부족 (주문수량 > 가능수량). 투자금액 설정을 낮추거나 잔고를 확인하세요${rtCd}${trInfo}`);
          }
          throw new Error(errMsg + rtCd + trInfo + hint);
        }
        // ✅ ordNo 로깅 — 실제 주문번호 확인용 (없어도 rt_cd=0이면 접수된 것으로 처리)
        addLog('info', `📥 국내 매수접수: ${candidate.ticker} ${qtyInt}주 @${fmtPrice(price)}원 [ordNo:${data.ordNo||'없음'} trId:${data.trId||''}]`);
        if (data.odnoMissing) addLog('warn', `⚠️ ${candidate.ticker} 매수 ordNo 없음 — KIS 야간/시간외 접수 케이스. HTS에서 확인 필요`);
        // 🔍 3초 후 체결 확인 (비동기)
        if (data.ordNo) {
          const _ordNo = data.ordNo, _ticker = candidate.ticker;
          setTimeout(() => checkFillStatus('KR', _ordNo, _ticker), 3000);
        }
      }
    } catch(e) {
      addLog('error', `❌ 매수 실패: ${candidate.ticker} — ${e.message}`);
      return;
    }
    // ── 실전: 매수 성공 → liveBalance 즉시 차감 (총자산 이중 계산 방지) ──
    // 30초 폴링으로 실제 잔고가 갱신될 때까지 추정값 유지
    const deductAmt = Math.round(isUs ? qtyInt * price * STATE.usdKrw : qtyInt * price);
    STATE.liveBalance         = Math.max(0, STATE.liveBalance - deductAmt);
    STATE.liveBalanceKrwForUs = Math.max(0, STATE.liveBalanceKrwForUs - deductAmt);
  } else {
    // 페이퍼 모드: 잔고 차감 (국내·미국 모두 원화)
    STATE.paperBalance -= Math.round(investAmt);
  }

  const pos = {
    ticker:       candidate.ticker,
    name:         candidate.name || candidate.ticker,
    entryPrice:   price,
    qty:          qtyInt,
    entryTime:    Date.now(),
    currentPrice: price,
    pnlPct:       0,
    peakPnl:      0,
    trailArmed:   false,
    score:        candidate.score,
    market:       candidate.market || 'KR', // 'KR' | 'US'
    // ✅ 미국주식 거래소 코드 저장 — 매도 시 재추론 오류 방지
    excd:         isUs ? (() => {
      const raw = candidate.excd || getUsExchangeCode(candidate.ticker);
      return (raw === 'NAS' || raw === 'NASD') ? 'NASD' : 'NYSE';
    })() : undefined,
  };
  STATE.positions.push(pos);
  savePositions(); // 매수 즉시 localStorage 저장
  const priceStr = isUs ? `$${price.toFixed(2)}` : fmtPrice(price) + '원';
  const amtStr   = isUs
    ? `$${(qtyInt * price).toFixed(2)} (≈${fmtManwon(Math.round(qtyInt * price * STATE.usdKrw))})`
    : fmtManwon(qtyInt * price);
  addLog('buy', `💰 ${mktFlag} 매수: ${pos.name} (${pos.ticker})`);
  addLog('buy', `   진입가 ${fmtPrice(pos.entryPrice)}원 | ${qty}주 | 투자 ${fmtPrice(qty * price)}원 [Kelly: 승률${(winRate*100).toFixed(0)}% × ×${drawdownFactor}]`);
  renderPositions();
  updateStatsUI(); // 매수 즉시 총자산 카드 반영

  // #4 잔고 자동 동기화: 실전 매수 성공 → 8초 후 실제 잔고 재조회
  if (STATE.mode === 'live' && KEYS.appKey) {
    setTimeout(async () => {
      if (STATE.liveBalanceFetching) return; // 이미 조회 중이면 스킵
      STATE.liveBalanceFetching = true;
      try {
        const result = await getLiveBalance();
        const bal = result?.balance ?? result ?? 0;
        if (bal > 0) {
          STATE.liveBalance         = bal;
          STATE.liveBalanceKrwForUs = bal;
          STATE.liveBalanceTs       = Date.now();
          addLog('info', `💰 매수 후 잔고 동기화: ${fmtPrice(bal)}원`);
          updateStatsUI();
        }
      } catch(e) { /* 무시 */ } finally {
        STATE.liveBalanceFetching = false;
        STATE.liveBalanceTs = Date.now();
      }
    }, 8000);
  }
  } finally {
    STATE._pendingTickers.delete(candidate.ticker); // 잠금 해제 (성공/실패 무관)
  }
}

// ─── 실시간 포지션 가격 업데이트 ──────────────────────────────
async function tickPositions() {
  // ── 실전 잔고 폴링 ─────────────────────────────────────────
  // 🕐 장 시간대별 잔고 API 분리:
  //   - 국내장(08:50~15:30 KST): 국내 원화 잔고만 조회 → KIS KR API 사용
  //   - 미국장(23:30~06:00 KST): 미국 달러 잔고만 조회 → KIS US API 사용
  //   - 장외시간(그 외): 마지막 조회 캐시 유지, 60초마다 각자 담당 API만 폴링
  if (STATE.mode === 'live' && KEYS.appKey && KEYS.accountNo) {
    const krOpen = isKrMarketOpen();         // KST 09:00~15:30
    const usOpen = isUsMarketOpen();         // KST 22:30~05:00 (서머타임)
    const { day: kstDay, min: nowMin } = nowKST();
    // 국내장 전 준비 포함: 08:50~15:30 (평일 KST)
    const krSessionActive = (kstDay >= 1 && kstDay <= 5) && (nowMin >= 8 * 60 + 50) && (nowMin < 15 * 60 + 30);
    // 미국장 세션: isUsMarketOpen() 그대로
    const usSessionActive = usOpen;

    // ── 국내 원화 잔고 폴링 ───────────────────────────────────
    // 국내장 세션(08:50~15:30)이거나 market=KR/BOTH이고 미국장이 아닐 때만
    const shouldFetchKr = (STATE.market === 'KR' || STATE.market === 'BOTH') &&
                          (krSessionActive || (!usSessionActive));
    if (shouldFetchKr) {
      const elapsed = Date.now() - STATE.liveBalanceTs;
      if (!STATE.liveBalanceFetching && elapsed > 30000) {
        STATE.liveBalanceFetching = true;
        if (STATE.liveBalanceTs === 0) {
          const cashEl = document.getElementById('stat-cash');
          if (cashEl) cashEl.textContent = '조회 중…';
        }
        getLiveBalance().then(result => {
          const bal = result?.balance ?? result ?? 0;
          const prev = STATE.liveBalance;
          // ✅ bal <= 0이면 저장하지 않음 — 음수/0 잔고 오염 방지
          // (KIS 매수 직후 ord_psbl_cash가 일시적으로 0/음수 반환하는 경우 무시)
          if (bal > 0) {
            STATE.liveBalance   = bal;
            STATE.liveBalanceKrwForUs = bal; // 통합증거금 자동 동기화
          }
          STATE.liveBalanceTs = Date.now();
          STATE.liveBalanceFetching = false;
          if (bal > 0 && bal !== prev) { addLog('info', `💰 국내 잔고 갱신: ${fmtPrice(bal)}원`); updateStatsUI(); }
          else updateStatsUI();
        }).catch(() => {
          STATE.liveBalanceFetching = false;
          STATE.liveBalanceTs = Date.now();
        });
      }
    }

    // ── 미국 달러 잔고 폴링 ───────────────────────────────────
    // 미국장 세션(23:30~06:00)이거나 market=US/BOTH이고 국내장 세션이 아닐 때만
    // 봇 실행 중: 배치 조회가 담당 → 여기선 스킵
    // 봇 정지 중: 60초마다 UI 표시용 폴링
    const shouldFetchUs = (STATE.market === 'US' || STATE.market === 'BOTH') &&
                          (usSessionActive || (!krSessionActive));
    if (shouldFetchUs) {
      const elapsedUsd = Date.now() - STATE.liveBalanceUsdTs;
      const botRunning = STATE.running;
      const canFetchUs = !STATE.liveBalanceUsdFetching && (
        botRunning
          ? false         // 봇 실행 중: 배치 조회가 담당
          : elapsedUsd > 60000  // 봇 정지: 60초마다 UI 폴링
      );
      if (canFetchUs) {
        STATE.liveBalanceUsdFetching = true;
        getUsLiveBalance().then(usResult => {
          const usd = usResult?.cashUsd ?? usResult ?? STATE.liveBalanceUsd;
          const prev = STATE.liveBalanceUsd;
          STATE.liveBalanceUsd    = usd;
          STATE.liveBalanceUsdTs  = Date.now();
          STATE.liveBalanceUsdFetching = false;
          if (usd > 0 && Math.abs(usd - prev) > 0.01) {
            addLog('info', `💵 미국 달러 잔고 갱신: $${usd.toFixed(2)} (≈${fmtPrice(Math.round(usd * STATE.usdKrw))}원)`);
            updateStatsUI();
          } else updateStatsUI();
        }).catch(() => {
          STATE.liveBalanceUsdFetching = false;
          STATE.liveBalanceUsdTs = Date.now();
        });
      }
    }
  }

  if (STATE.positions.length === 0) return;

  for (const pos of STATE.positions) {
    const price = await fetchCurrentPrice(pos.ticker, pos.market);
    if (price) {
      pos.currentPrice = price;
      pos.pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      if (pos.pnlPct > (pos.peakPnl || 0)) pos.peakPnl = pos.pnlPct;
    }
  }
  savePositions(); // 현재가 갱신마다 저장 (최신 상태 유지)
  renderPositions();
  updateStatsUI();
}

async function fetchCurrentPrice(ticker, market) {
  const mkt = market || (STATE.positions.find(p => p.ticker === ticker)?.market) || 'KR';
  if (mkt === 'US') {
    return await fetchUsCurrentPrice(ticker);
  }
  // 국내주식 — 실전 모드에서 KIS 우선, 실패 시 네이버 폴백
  if (STATE.mode === 'live' && KEYS.appKey) {
    // 1) KIS FHKST01010100 시도
    try {
      const res = await fetch('/api/kis/kr/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appKey: KEYS.appKey,
          appSecret: KEYS.appSecret,
          code: ticker,
          kisToken: KEYS.kisToken || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok && data.price > 0) return data.price;
    } catch { /* KIS 실패 → 네이버 폴백 */ }
    // 2) 네이버 폴백
    try {
      const res = await axios.get(`/api/naver/price/${ticker}`, { timeout: 4000 });
      return res.data?.price || null;
    } catch { return null; }
  }
  // 페이퍼: 시뮬레이션
  const pos = STATE.positions.find(p => p.ticker === ticker);
  if (!pos) return null;
  const drift = (Math.random() - 0.48) * pos.entryPrice * 0.003;
  return Math.round(pos.currentPrice + drift);
}

/** 미국주식 현재가 조회 (달러) */
async function fetchUsCurrentPrice(symbol) {
  if (STATE.mode === 'live' && KEYS.appKey) {
    try {
      const excd = getUsExchangeCode(symbol);
      const res = await fetch('/api/kis/us/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey: KEYS.appKey, appSecret: KEYS.appSecret, symbol, excd }),
      });
      const data = await res.json();
      if (data.ok && data.price > 0) return data.price;
    } catch {}
  }
  // 페이퍼: 시뮬레이션 (달러 기반 소폭 변동)
  const pos = STATE.positions.find(p => p.ticker === symbol);
  if (!pos) return null;
  const drift = (Math.random() - 0.48) * pos.entryPrice * 0.002;
  return Math.round((pos.currentPrice + drift) * 100) / 100; // 소수점 2자리
}

/** 미국주식 거래소 코드 추론 (NASD=나스닥, NYSE=뉴욕) */
function getUsExchangeCode(symbol) {
  // 나스닥 대표 종목
  const nasd = ['AAPL','MSFT','AMZN','GOOGL','GOOG','META','NVDA','TSLA','AVGO','COST',
    'NFLX','AMD','INTC','QCOM','AMAT','MU','LRCX','KLAC','MRVL','ADI',
    'PYPL','SBUX','GILD','REGN','VRTX','IDXX','BIIB','ILMN','ALGN','SGEN',
    'PANW','FTNT','CDNS','SNPS','ANSS','CTSH','FISV','PAYX','FAST','CTAS'];
  return nasd.includes(symbol.toUpperCase()) ? 'NAS' : 'NYS';
}

async function getLiveBalance() {
  if (!KEYS.appKey || !KEYS.accountNo) {
    // API 키 없으면 수동 입력 잔고 반환
    return parseInt(localStorage.getItem('manual_krw_balance') || '0');
  }
  // 수동 입력 잔고가 있으면 우선 사용 (서버 차단 환경 대응)
  const manualBal = parseInt(localStorage.getItem('manual_krw_balance') || '0');
  try {
    const res = await fetch('/api/kis/balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: KEYS.appKey, appSecret: KEYS.appSecret, accountNo: KEYS.accountNo, kisToken: getCachedKisToken() }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (data.serverBlocked) {
      // 서버→KIS 차단 — 수동 잔고 사용
      if (manualBal > 0) {
        addLog('info', `💴 서버 KIS 차단 — 수동 입력 잔고 사용: ${fmtPrice(manualBal)}원`);
        STATE.liveBalanceTs = Date.now();
        return manualBal;
      }
      // 수동 잔고도 없으면 입력 유도
      addLog('warn', '⚠️ 서버→KIS 연결 차단 — 총자산 카드의 ✏️ 버튼으로 원화 잔고를 입력하세요');
      openBalanceInput();
      STATE.liveBalanceTs = Date.now();
      return 0;
    }
    if (data.ok && typeof data.balance === 'number') {
      // totalAsset: KIS API 총평가금액 (주문가능현금 + 주식평가금 합산)
      if (data.totalAsset && data.totalAsset > 0) {
        STATE.liveTotalAsset = data.totalAsset;
      }
      return { balance: data.balance, totalAsset: data.totalAsset || 0, holdings: data.holdings || [] };
    }
    if (data.error) {
      const hint = data.rtCd ? ` [rt_cd=${data.rtCd}]` : '';
      addLog('warn', `⚠️ 잔고 조회 오류${hint}: ${data.error}`);
      if (data.rtCd === '1') {
        addLog('info', '💡 토큰 만료 가능성 — 잠시 후 자동 재시도합니다');
      } else if (data.error.includes('INVALID_CHECK_ACNO')) {
        addLog('error', '❌ 계좌번호 불일치 — APP KEY 발급 시 등록한 계좌번호와 다릅니다');
        addLog('info', '💡 해결: KIS 개발자센터(apiportal.koreainvestment.com) → 내 앱 → 계좌번호 확인');
        addLog('info', `   현재 입력된 계좌번호: ${KEYS.accountNo}`);
      }
      STATE.liveBalanceTs = Date.now();
      return { balance: STATE.liveBalance, holdings: [] };
    }
    STATE.liveBalanceTs = Date.now();
    return { balance: STATE.liveBalance, holdings: [] };
  } catch (e) {
    addLog('warn', '⚠️ 잔고 조회 네트워크 오류: ' + (e?.message || ''));
    STATE.liveBalanceTs = Date.now();
    return { balance: STATE.liveBalance, holdings: [] };
  }
}

/** 미국주식 달러 잔고 조회 */
// ── 인플라이트 뮤텍스: 동시에 여러 곳에서 호출돼도 실제 fetch는 1번만 실행
let _usBalanceInflight = null;

async function getUsLiveBalance() {
  if (!KEYS.appKey || !KEYS.accountNo) return STATE.liveBalanceUsd;
  // 이미 진행 중인 요청이 있으면 같은 Promise를 공유 (중복 발급 방지)
  if (_usBalanceInflight) return _usBalanceInflight;
  _usBalanceInflight = _doGetUsLiveBalance().finally(() => { _usBalanceInflight = null; });
  return _usBalanceInflight;
}

async function _doGetUsLiveBalance() {
  try {
    const res = await fetch('/api/kis/us/balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: KEYS.appKey, appSecret: KEYS.appSecret, accountNo: KEYS.accountNo, kisToken: getCachedKisToken() }),
    });
    const data = await res.json();
    if (data.serverBlocked) {
      addLog('warn', '⚠️ 서버→KIS 연결 차단 — 미국주식 잔고 조회 불가');
      STATE.liveBalanceUsdTs = Date.now();
      return STATE.liveBalanceUsd;
    }
    if (data.ok && typeof data.cashUsd === 'number') {
      // ✅ 정상 응답
      // 통합증거금: 원화 가용금액 저장 (달러 잔고=0이어도 원화로 매수 가능)
      if (typeof data.cashKrw === 'number' && data.cashKrw > 0) {
        STATE.liveBalanceKrwForUs = data.cashKrw;
        addLog('info', `💴 통합증거금 원화 가용: ${fmtPrice(data.cashKrw)}원 (환전 없이 해외주식 매수 가능)`);
      }
      return { cashUsd: data.cashUsd, holdings: data.holdings || [] };
    }
    if (data.error) {
      const hint = data.rtCd ? ` [rt_cd=${data.rtCd}]` : '';
      addLog('warn', `⚠️ 미국주식 잔고 오류${hint}: ${data.error}`);
      if (data.rtCd === '1') {
        addLog('info', '💡 토큰 만료 — 잠시 후 자동 재시도합니다');
      } else if (data.error.includes('INVALID_CHECK_ACNO')) {
        addLog('error', '❌ 계좌번호 불일치 — APP KEY 발급 시 등록한 계좌번호와 다릅니다');
        addLog('info', '💡 해결: KIS 개발자센터 → 내 앱 → 등록된 계좌번호 확인 후 동일하게 입력');
      }
      STATE.liveBalanceUsdTs = Date.now();
      return STATE.liveBalanceUsd;
    }
    STATE.liveBalanceUsdTs = Date.now();
    return STATE.liveBalanceUsd;
  } catch (e) {
    addLog('warn', '⚠️ 미국주식 잔고 네트워크 오류: ' + (e?.message || ''));
    STATE.liveBalanceUsdTs = Date.now();
    return STATE.liveBalanceUsd;
  }
}

/** 원/달러 환율 조회 + 캐시 */
async function fetchUsdKrw() {
  // 5분 캐시
  if (STATE.usdKrwTs && Date.now() - STATE.usdKrwTs < 5 * 60 * 1000) return STATE.usdKrw;
  try {
    const res = await fetch('/api/forex/usd-krw', { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (data.ok && data.rate > 0) {
      STATE.usdKrw   = data.rate;
      STATE.usdKrwTs = Date.now();
      // 환율 표시 업데이트
      const fxEl = document.getElementById('fx-rate-display');
      if (fxEl) fxEl.textContent = `$1 = ${fmtPrice(data.rate)}원`;
      addLog('info', `💱 환율 갱신: $1 = ${fmtPrice(data.rate)}원 (출처: ${data.source})`);
    }
  } catch {}
  return STATE.usdKrw;
}

// ─── 포지션 UI 렌더링 ─────────────────────────────────────────
function renderPositions() {
  const el = document.getElementById('positions-list');
  document.getElementById('stat-positions').textContent =
    `${STATE.positions.length} / ${STATE.config.maxPositions}`;

  if (STATE.positions.length === 0) {
    el.innerHTML = '<div class="text-gray-600 text-sm text-center py-8">포지션 없음<br><span class="text-xs">봇을 시작하면 자동으로 종목을 매수합니다</span></div>';
    return;
  }

  el.innerHTML = STATE.positions.map(pos => {
    const ep        = EXIT_PARAMS[STATE.strategy] || EXIT_PARAMS.scalping;
    const isUs      = pos.market === 'US';
    const netPnl    = pos.pnlPct - 0.245;
    const isProfit  = netPnl >= 0;
    const holdMin   = Math.floor((Date.now() - pos.entryTime) / 60000);
    const holdSec   = Math.floor(((Date.now() - pos.entryTime) % 60000) / 1000);
    // 미국주식: 달러→원화 환산 손익 표시
    const pnlAmtRaw = pos.entryPrice * pos.qty * netPnl / 100;
    const pnlAmt    = isUs ? Math.round(pnlAmtRaw * (STATE.usdKrw || 1380)) : Math.round(pnlAmtRaw);
    const bar       = Math.min(Math.abs(pos.pnlPct) / STATE.config.profitTarget * 100, 100);
    const peakPnl   = Math.max(0, pos.peakPnl || 0); // 항상 0 이상 보정
    const dropFromPeak = peakPnl - pos.pnlPct;

    // 트레일 상태 배지
    const trailBadge = pos.trailArmed
      ? `<span class="ml-1 px-1 py-0.5 rounded text-xs bg-orange-900/60 text-orange-300">🔒트레일</span>`
      : (pos.pnlPct >= STATE.config.profitTarget * ep.trailTriggerMult
          ? `<span class="ml-1 px-1 py-0.5 rounded text-xs bg-yellow-900/60 text-yellow-300">목표도달</span>`
          : '');

    // 고점 대비 낙폭 경고
    const dropWarn = pos.trailArmed && dropFromPeak > ep.trailDropPct * 0.5
      ? `<span class="text-orange-400">↘ 고점-${dropFromPeak.toFixed(2)}%p (청산기준 -${ep.trailDropPct}%p)</span>`
      : `<span>익절까지 ${Math.max(0, (STATE.config.profitTarget - pos.pnlPct)).toFixed(2)}%</span>`;

    return `
    <div class="position-card ${isProfit ? 'profit' : 'loss'}">
      <div class="flex justify-between items-start mb-1">
        <div class="flex items-center flex-wrap gap-1">
          <span class="font-medium text-sm text-white">${pos.name}</span>
          <span class="text-gray-500 text-xs">${pos.ticker}</span>
          ${trailBadge}
        </div>
        <div class="text-right">
          <div class="${isProfit ? 'text-profit' : 'text-loss'} font-bold text-sm">
            ${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(2)}%
          </div>
          <div class="text-xs ${isProfit ? 'text-green-500' : 'text-red-500'}">
            ${pnlAmt >= 0 ? '+' : ''}${fmtPrice(pnlAmt)}원${isUs ? ` (~$${(pnlAmtRaw >= 0 ? '+' : '')}${pnlAmtRaw.toFixed(2)})` : ''}
          </div>
        </div>
      </div>
      <div class="text-xs text-gray-500 flex justify-between">
        <span>진입 ${isUs ? '$' : ''}${isUs ? pos.entryPrice.toFixed(2) : fmtPrice(pos.entryPrice)} → 현재 ${isUs ? '$' : ''}${isUs ? (pos.currentPrice || 0).toFixed(2) : fmtPrice(pos.currentPrice)}</span>
        <span>${holdMin}분 ${holdSec}초</span>
      </div>
      ${peakPnl > 0 ? `<div class="text-xs text-gray-600 mt-0.5">고점 +${peakPnl.toFixed(2)}% | 슬리피지 -${ep.slippagePct}%</div>` : ''}
      <div class="mt-1.5 h-1 bg-gray-800 rounded">
        <div class="h-1 rounded ${pos.trailArmed ? 'bg-orange-500' : (isProfit ? 'bg-green-500' : 'bg-red-500')}" style="width:${bar}%"></div>
      </div>
      <div class="text-xs text-gray-600 mt-0.5">${dropWarn}</div>
    </div>`;
  }).join('');
}

async function refreshPositions() {
  addLog('info', '🔄 포지션 수동 새로고침');
  // 실전 모드: KIS 실보유 재조회 → AMD 같은 장외 매도 후 복원에 사용
  if (STATE.mode === 'live' && KEYS.appKey && KEYS.accountNo) {
    addLog('info', '   🔄 KIS 실보유 재조회 중...');
    await syncKisPositions();
  } else {
    tickPositions();
  }
}

// ─── 포지션 영구 저장/복원 (localStorage) ────────────────────────
/** 현재 포지션 배열을 localStorage에 저장 */
function savePositions() {
  try {
    // mode별로 별도 키로 저장 (실전/페이퍼 분리)
    const key = STATE.mode === 'live' ? 'live_positions' : 'paper_positions';
    localStorage.setItem(key, JSON.stringify(STATE.positions));
  } catch (e) { /* quota exceeded 등 무시 */ }
}

/** 저장된 포지션 복원 + 실전 모드 시 KIS 실보유 포지션 병합 */
async function loadPositions() {
  const key = STATE.mode === 'live' ? 'live_positions' : 'paper_positions';
  try {
    // ── 1) localStorage 복원 ─────────────────────────────────
    const raw = localStorage.getItem(key);
    const saved = (raw ? JSON.parse(raw) : null);
    if (Array.isArray(saved) && saved.length > 0) {
      STATE.positions = saved;
      renderPositions();
      updateStatsUI();
      addLog('info', `📂 포지션 ${saved.length}개 복원됨`);
    }

    // ── 2) 실전 모드 + API 키 있을 때 KIS 실보유 포지션 동기화 ──
    if (STATE.mode === 'live' && KEYS.appKey && KEYS.accountNo) {
      addLog('info', '🔄 KIS 실보유 포지션 조회 중...');
      await syncKisPositions();
    }

    // ── 3) 포지션 현재가 갱신 ────────────────────────────────
    if (STATE.positions.length > 0) {
      addLog('info', `📊 보유 포지션 ${STATE.positions.length}개 — 현재가 갱신 중...`);
      for (const pos of STATE.positions) {
        try {
          const price = await fetchCurrentPrice(pos.ticker, pos.market);
          if (price && price > 0) {
            pos.currentPrice = price;
            pos.pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
            if (pos.pnlPct > (pos.peakPnl || 0)) pos.peakPnl = pos.pnlPct;
          }
        } catch { /* 개별 실패는 무시 */ }
      }
      savePositions();
      renderPositions();
      updateStatsUI();
      addLog('info', `✅ 현재가 갱신 완료`);
    }
  } catch (e) {
    addLog('warn', `⚠️ 포지션 복원 실패: ${e.message}`);
  }
}

/**
 * KIS API에서 실제 보유 포지션을 가져와 STATE.positions 병합
 * - 봇 매수 포지션: localStorage에 있음 → 진입가/시간 유지
 * - KIS 앱/HTS 직접 매수: localStorage에 없음 → 신규 추가
 * - localStorage에만 있고 KIS에는 없는 포지션: 청산된 것 → 제거
 */
async function syncKisPositions() {
  try {
    const market = STATE.market || 'KR';
    const kisHoldings = [];
    let anyApiSuccess = false;   // API 성공 여부 추적 (에러=포지션 유지, 성공=병합)
    let tokenRateLimited = false; // 토큰 발급 횟수 초과 여부

    // ── 헬퍼: 에러 메시지에서 토큰 Rate Limit 판별 ─────────────
    function isTokenRateLimit(errMsg) {
      return errMsg && (
        errMsg.includes('1분당') ||
        errMsg.includes('접근토큰') ||
        errMsg.includes('다시 시도') ||
        errMsg.includes('rate') ||
        errMsg.includes('Rate')
      );
    }

    // ── 국내주식 보유종목 조회 ─────────────────────────────────
    // ⚠️ 재접속 시 항상 국내+미국 둘 다 조회 (market 설정과 무관)
    // → KIS에 실보유가 있으면 무조건 포지션에 반영
    if (true) { // 항상 국내 조회 (KR / BOTH / US 관계없이)
      try {
        const res = await fetch('/api/kis/balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appKey: KEYS.appKey, appSecret: KEYS.appSecret, accountNo: KEYS.accountNo, kisToken: getCachedKisToken() }),
          signal: AbortSignal.timeout(12000),
        });
        const data = await res.json();
        if (data.ok && Array.isArray(data.holdings)) {
          kisHoldings.push(...data.holdings);
          anyApiSuccess = true;
          addLog('info', `   🇰🇷 국내 보유: ${data.holdings.length}종목`);
        } else if (data.error) {
          if (isTokenRateLimit(data.error)) {
            tokenRateLimited = true;
            addLog('warn', `   ⏳ KIS 토큰 발급 대기 중 (1분 제한) — 국내 조회 건너뜀`);
          } else {
            addLog('warn', `   ⚠️ 국내 보유종목 조회 오류: ${data.error}`);
          }
        }
      } catch (e) {
        addLog('warn', `   ⚠️ 국내 보유종목 조회 실패: ${e.message}`);
      }
    }

    // ── 국내 조회 후 토큰 Rate Limit이면 미국도 건너뜀 ────────────
    if (tokenRateLimited) {
      addLog('warn', `   ⏳ 토큰 Rate Limit — 미국 조회도 건너뜀. 1분 후 자동 재시도합니다.`);
      // 1분 후 자동 재시도 (포지션 유지 상태로)
      setTimeout(() => {
        if (STATE.mode === 'live' && KEYS.appKey && KEYS.accountNo) {
          addLog('info', '🔄 KIS 포지션 자동 재조회 (토큰 대기 완료)...');
          syncKisPositions();
        }
      }, 62000);
      // ✅ 기존 포지션 그대로 화면에 표시
      renderPositions();
      updateStatsUI();
      return; // 기존 포지션 그대로 유지
    }

    // ── 미국주식 보유종목 조회 ─────────────────────────────────
    // ⚠️ 재접속 시 항상 미국도 조회 (국내 설정이어도 KIS에 미국 보유 있으면 반영)
    if (true) { // 항상 미국 조회
      try {
        const res = await fetch('/api/kis/us/balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appKey: KEYS.appKey, appSecret: KEYS.appSecret, accountNo: KEYS.accountNo, kisToken: getCachedKisToken() }),
          signal: AbortSignal.timeout(12000),
        });
        const data = await res.json();
        if (data.ok && Array.isArray(data.holdings)) {
          kisHoldings.push(...data.holdings);
          anyApiSuccess = true;
          addLog('info', `   🇺🇸 미국 보유: ${data.holdings.length}종목`);
        } else if (data.error) {
          if (isTokenRateLimit(data.error)) {
            tokenRateLimited = true;
            addLog('warn', `   ⏳ KIS 토큰 Rate Limit — 미국 조회 건너뜀. 1분 후 자동 재시도합니다.`);
            setTimeout(() => {
              if (STATE.mode === 'live' && KEYS.appKey && KEYS.accountNo) {
                addLog('info', '🔄 KIS 포지션 자동 재조회 (토큰 대기 완료)...');
                syncKisPositions();
              }
            }, 62000);
          } else {
            addLog('warn', `   ⚠️ 미국 보유종목 조회 오류: ${data.error}`);
          }
        }
      } catch (e) {
        addLog('warn', `   ⚠️ 미국 보유종목 조회 실패: ${e.message}`);
      }
    }

    // ── API 에러 시 기존 포지션 보존 (절대 초기화 금지) ──────────
    // anyApiSuccess=false AND tokenRateLimited=true → 재시도 예약됨, 포지션 유지
    // anyApiSuccess=false AND error → API 오류, 포지션 유지 (데이터 손실 방지)
    if (!anyApiSuccess) {
      if (tokenRateLimited) {
        addLog('warn', `⏳ 토큰 Rate Limit — 기존 포지션 ${STATE.positions.length}개 유지. 62초 후 재시도합니다.`);
      } else {
        addLog('warn', `⚠️ KIS API 응답 없음 — 기존 포지션 ${STATE.positions.length}개 유지 (초기화 안 함)`);
      }
      renderPositions();
      updateStatsUI();
      return;
    }

    // ── 일부 조회 실패(Rate Limit 등)로 데이터가 불완전하면 초기화 금지 ──
    // ex) 미국주식 보유 중인데 미국 조회가 Rate Limit으로 스킵된 경우
    if (tokenRateLimited) {
      addLog('warn', `⚠️ 일부 조회 실패(Rate Limit) — 불완전한 데이터로 포지션 초기화 방지. 기존 ${STATE.positions.length}개 유지`);
      if (kisHoldings.length > 0) {
        // 조회된 종목만 업데이트, 나머지는 기존 유지
        for (const h of kisHoldings) {
          const existing = STATE.positions.find(p => p.ticker === h.ticker);
          if (existing) {
            existing.qty          = h.qty;
            existing.currentPrice = h.currentPrice > 0 ? h.currentPrice : existing.currentPrice;
            // ✅ avgPrice 차이가 있으면 진입가 갱신 (odnoMissing 수정)
            if (h.avgPrice > 0) {
              const priceDiff = Math.abs(h.avgPrice - existing.entryPrice) / existing.entryPrice;
              if (priceDiff > 0.005) {
                existing.entryPrice = h.avgPrice;
                existing.pnlPct = existing.currentPrice > 0
                  ? ((existing.currentPrice - existing.entryPrice) / existing.entryPrice) * 100
                  : 0;
                if (existing.pnlPct > (existing.peakPnl || 0)) existing.peakPnl = existing.pnlPct;
              }
            }
          }
        }
      }
      renderPositions();
      updateStatsUI();
      return;
    }

    // ── API 성공(전체) + 보유종목 0개 = 실제로 보유 없음 ───────────────
    if (kisHoldings.length === 0) {
      addLog('info', `   ℹ️ KIS 실보유 없음 — 포지션 초기화`);
      STATE.positions = [];
      savePositions();
      renderPositions();
      updateStatsUI();
      return;
    }

    // ── KIS 보유종목 기준으로 STATE.positions 병합 ─────────────
    const prevTickers = STATE.positions.map(p => p.ticker);
    const newPositions = [];
    for (const h of kisHoldings) {
      if (!h.ticker || h.qty <= 0) continue;
      const existing = STATE.positions.find(p => p.ticker === h.ticker);
      if (existing) {
        // 기존 포지션 업데이트 (수량/현재가 갱신)
        existing.qty          = h.qty;
        existing.currentPrice = h.currentPrice > 0 ? h.currentPrice : existing.currentPrice;
        // ✅ KIS avgPrice가 있고 기존 진입가와 1% 이상 차이나면 → 실제 평균매수가로 교체
        // (odnoMissing / 직접 주문 케이스에서 스캔가 오염 수정)
        if (h.avgPrice > 0) {
          const priceDiff = Math.abs(h.avgPrice - existing.entryPrice) / existing.entryPrice;
          if (priceDiff > 0.005) { // 0.5% 이상 차이 시 교체 (호가 단위 오차 허용)
            const oldEntry = existing.entryPrice;
            existing.entryPrice = h.avgPrice;
            // PnL 재계산
            existing.pnlPct = existing.currentPrice > 0
              ? ((existing.currentPrice - existing.entryPrice) / existing.entryPrice) * 100
              : 0;
            if (existing.pnlPct > (existing.peakPnl || 0)) existing.peakPnl = existing.pnlPct;
            const mkt = existing.market === 'US' ? 'US' : 'KR';
            const fmt = mkt === 'US'
              ? `$${oldEntry.toFixed(2)} → $${h.avgPrice.toFixed(2)}`
              : `${fmtPrice(oldEntry)}원 → ${fmtPrice(h.avgPrice)}원`;
            addLog('info', `🔄 진입가 갱신(KIS싱크) [${mkt}] ${existing.ticker}: ${fmt} | PnL: ${existing.pnlPct.toFixed(2)}%`);
          }
        }
        if (h.pnlPct && h.pnlPct !== 0) existing.pnlPct = h.pnlPct;
        newPositions.push(existing);
      } else {
        // KIS에만 있는 종목 (직접 매수) → 신규 추가
        const avgP = h.avgPrice > 0 ? h.avgPrice : (h.currentPrice > 0 ? h.currentPrice : 1);
        newPositions.push({
          ticker:       h.ticker,
          name:         h.name || h.ticker,
          entryPrice:   avgP,
          qty:          h.qty,
          entryTime:    Date.now(),
          currentPrice: h.currentPrice > 0 ? h.currentPrice : avgP,
          pnlPct:       h.pnlPct || 0,
          peakPnl:      Math.max(0, h.pnlPct || 0),
          trailArmed:   false,
          score:        50,
          market:       h.market || 'KR',
          excd:         h.excd || '',
          fromKis:      true,
        });
        addLog('info', `   ➕ KIS 종목 추가: ${h.name || h.ticker} × ${h.qty}주 @ ${h.market === 'US' ? '$' : '₩'}${(h.avgPrice || h.currentPrice || 0).toLocaleString()}`);
      }
    }

    const added   = newPositions.filter(p => !prevTickers.includes(p.ticker)).length;
    const removed = prevTickers.filter(t => !newPositions.find(n => n.ticker === t)).length;
    STATE.positions = newPositions;
    savePositions();

    if (added > 0 || removed > 0) {
      addLog('info', `✅ KIS 포지션 동기화: +${added}추가 / -${removed}제거 → 총 ${newPositions.length}개`);
    } else {
      addLog('info', `✅ KIS 포지션 동기화: ${newPositions.length}개 일치 (변동 없음)`);
    }
    renderPositions();
    updateStatsUI();
  } catch (e) {
    addLog('warn', `⚠️ KIS 포지션 동기화 실패: ${e.message}`);
    // 예외 발생 시에도 기존 포지션 유지 (renderPositions 호출로 현재 상태 표시)
    renderPositions();
    updateStatsUI();
  }
}

// ─── 거래 내역 ────────────────────────────────────────────────
async function recordTrade(trade) {
  try { await axios.post('/api/trades', trade, { headers: apiHeaders() }); } catch { }
  const saved = JSON.parse(localStorage.getItem('trade_history') || '[]');
  saved.unshift(trade);
  localStorage.setItem('trade_history', JSON.stringify(saved.slice(0, 200)));
}

async function loadTradeHistory() {
  let trades = JSON.parse(localStorage.getItem('trade_history') || '[]');
  try {
    const res = await axios.get('/api/trades', { headers: apiHeaders(), timeout: 3000 });
    if (Array.isArray(res.data) && res.data.length > 0) trades = res.data;
  } catch { }
  renderTradeHistory(trades);
}

function renderTradeHistory(trades) {
  const tbody = document.getElementById('trades-tbody');
  if (!trades || trades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-600 py-6">거래 내역 없음</td></tr>';
    return;
  }

  tbody.innerHTML = trades.slice(0, 30).map(t => {
    const isWin = t.pnlPct > 0;
    const pnlText = `${t.pnlPct >= 0 ? '+' : ''}${parseFloat(t.pnlPct || 0).toFixed(2)}%`;
    return `<tr class="text-xs">
      <td class="py-1.5 text-white">${t.name || t.ticker}</td>
      <td class="py-1.5 text-right text-gray-400">${fmtPrice(t.entryPrice)}</td>
      <td class="py-1.5 text-right text-gray-400">${fmtPrice(t.exitPrice)}</td>
      <td class="py-1.5 text-right ${isWin ? 'text-green-400' : 'text-red-400'}">${pnlText}</td>
      <td class="py-1.5 text-right">
        <span class="px-1.5 py-0.5 rounded text-xs ${isWin ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}">
          ${isWin ? '익절' : '손절'}
        </span>
      </td>
    </tr>`;
  }).join('');
}

async function clearTrades() {
  if (!confirm('거래 내역을 모두 삭제할까요?')) return;
  localStorage.removeItem('trade_history');
  renderTradeHistory([]);
  addLog('warn', '🗑️ 거래 내역 삭제');
}

// ─── 통계 UI ─────────────────────────────────────────────────
function updateStatsUI() {
  const { totalTrades, winTrades, totalProfit, dailyProfit } = STATE.stats;
  const winRate = totalTrades > 0 ? Math.round((winTrades / totalTrades) * 100) : 0;
  const maxPos  = STATE.config.maxPositions;
  const curPos  = STATE.positions.length;

  // ── 총 자산 카드 (실시간 반영) ──────────────────────
  // 보유 주식 현재 평가금
  const stockVal = STATE.positions.reduce((sum, p) => sum + (p.currentPrice * p.qty), 0);
  // 미실현 손익 (수수료 차감 전)
  const unrealizedPnl = STATE.positions.reduce((sum, p) => {
    const pnl = (p.currentPrice - p.entryPrice) * p.qty;
    return sum + pnl;
  }, 0);

  if (STATE.mode === 'paper') {
    const mkt = STATE.market;
    // 국내 포지션 평가금
    const stockValKr  = STATE.positions.filter(p => p.market !== 'US').reduce((s,p) => s + p.currentPrice * p.qty, 0);
    // 미국 포지션 평가금 (달러 → 원화)
    const stockValUsd = STATE.positions.filter(p => p.market === 'US').reduce((s,p) => s + p.currentPrice * p.qty, 0);
    const stockValUsdKrw = Math.round(stockValUsd * STATE.usdKrw);

    let totalAsset, cashDisplay, stockDisplay;
    if (mkt === 'US') {
      totalAsset   = Math.round((STATE.paperBalanceUsd + stockValUsd) * STATE.usdKrw);
      cashDisplay  = `$${STATE.paperBalanceUsd.toFixed(2)} (≈${fmtPrice(Math.round(STATE.paperBalanceUsd * STATE.usdKrw))}원)`;
      stockDisplay = stockValUsd > 0 ? `$${stockValUsd.toFixed(2)} (≈${fmtPrice(stockValUsdKrw)}원)` : '없음';
    } else if (mkt === 'BOTH') {
      totalAsset   = STATE.paperBalance + stockValKr + Math.round(STATE.paperBalanceUsd * STATE.usdKrw) + stockValUsdKrw;
      cashDisplay  = `${fmtPrice(STATE.paperBalance)}원 / $${STATE.paperBalanceUsd.toFixed(2)}`;
      stockDisplay = (stockValKr + stockValUsdKrw) > 0 ? fmtPrice(stockValKr + stockValUsdKrw) + '원' : '없음';
    } else {
      totalAsset   = STATE.paperBalance + stockValKr;
      cashDisplay  = fmtPrice(STATE.paperBalance) + '원';
      stockDisplay = stockValKr > 0 ? fmtPrice(stockValKr) + '원' : '없음';
    }

    const initialCap = STATE.config.paperCapital;
    // 총자산 표시
    document.getElementById('stat-total-asset').textContent = fmtPrice(totalAsset) + '원';
    // 자산 변동 색상
    const assetEl = document.getElementById('stat-total-asset');
    const assetDiff = totalAsset - initialCap;
    assetEl.className = 'text-2xl font-bold ' + (assetDiff >= 0 ? 'text-white' : 'text-red-300') + ' tracking-tight';
    // 현금 / 주식평가 (시장 모드별 표시)
    document.getElementById('stat-cash').textContent        = cashDisplay;
    document.getElementById('stat-stock-value').textContent = stockDisplay;
    // 배지
    document.getElementById('stat-asset-badge').textContent = '페이퍼';
    // 진행 바: 현재자산 / 초기자산 비율
    const barPct = Math.min((totalAsset / Math.max(initialCap, 1)) * 100, 200);
    const barEl  = document.getElementById('stat-asset-bar');
    barEl.style.width      = Math.min(barPct, 100) + '%';
    barEl.className = 'h-0.5 rounded transition-all duration-500 ' + (assetDiff >= 0 ? 'bg-green-500' : 'bg-red-500');
  } else {
    // ── 실전 모드 — 캐시된 잔고 + 보유주식 평가금 합산 표시 ──
    const mkt       = STATE.market;
    const cash      = STATE.liveBalance;       // 캐시된 현금 잔고 (원화)
    const cashUsd   = STATE.liveBalanceUsd;    // 달러 현금 잔고
    const fetching  = STATE.liveBalanceFetching;
    const fetchingUsd = STATE.liveBalanceUsdFetching;
    const hasApiKey = !!KEYS.appKey && !!KEYS.accountNo; // API 키 + 계좌번호 모두 있어야 연결됨

    // 달러 포지션 평가금 (원화 환산)
    const stockValKr  = STATE.positions.filter(p => p.market !== 'US').reduce((s,p) => s + p.currentPrice * p.qty, 0);
    const stockValUsd = STATE.positions.filter(p => p.market === 'US').reduce((s,p) => s + p.currentPrice * p.qty, 0);
    const stockValUsdKrw = Math.round(stockValUsd * STATE.usdKrw);

    // ── 총자산 계산 ──
    // KIS API에서 받은 총평가금액(tot_evlu_amt) 우선 사용
    // → KIS가 이미 현금+주식평가를 합산한 정확한 값
    // → 없으면 주문가능현금(cash) + 주식평가금으로 계산
    const cashKrwForUs = STATE.liveBalanceKrwForUs > 0 ? STATE.liveBalanceKrwForUs : cash;
    let totalAsset = 0;
    if (STATE.liveTotalAsset > 0) {
      // KIS 총자산 직접 사용 (가장 정확)
      totalAsset = STATE.liveTotalAsset;
    } else if (mkt === 'KR') {
      totalAsset = cash + stockValKr;
    } else if (mkt === 'US') {
      totalAsset = cashKrwForUs + stockValUsdKrw;
    } else {
      totalAsset = cash + stockValKr + stockValUsdKrw;
    }

    const hasCash   = cash > 0 || cashUsd > 0 || cashKrwForUs > 0;
    const hasStock  = stockValKr > 0 || stockValUsd > 0;
    // 조회 완료 여부: 한 번이라도 조회를 완료했으면 true (잔고 0이어도)
    const hasQueried = STATE.liveBalanceTs > 0 || STATE.liveBalanceUsdTs > 0;

    // 총 자산 표시
    const assetEl = document.getElementById('stat-total-asset');
    if ((fetching || fetchingUsd) && !hasCash && !hasStock) {
      // 조회 진행 중
      assetEl.textContent = '조회 중…';
      assetEl.className = 'text-2xl font-bold text-yellow-400 tracking-tight';
    } else if (hasCash || hasStock) {
      // 잔고 있음
      assetEl.textContent = fmtPrice(totalAsset) + '원';
      assetEl.className = 'text-2xl font-bold text-white tracking-tight';
    } else if (hasQueried) {
      // 조회는 완료됐으나 잔고 0 (정상 — 주문 가능 현금 없는 상태)
      assetEl.textContent = fmtPrice(totalAsset) + '원';
      assetEl.className = 'text-2xl font-bold text-gray-300 tracking-tight';
    } else if (hasApiKey) {
      // API 키 + 계좌번호 있지만 아직 조회 시작 안 됨
      assetEl.textContent = '잔고 조회 중…';
      assetEl.className = 'text-2xl font-bold text-yellow-400 tracking-tight';
    } else if (KEYS.appKey && !KEYS.accountNo) {
      // API 키는 있지만 계좌번호 없음
      assetEl.textContent = '계좌번호 필요';
      assetEl.className = 'text-2xl font-bold text-orange-400 tracking-tight';
    } else {
      // API 키 자체가 없음
      assetEl.textContent = '계좌 연결 필요';
      assetEl.className = 'text-2xl font-bold text-gray-500 tracking-tight';
    }

    // 현금 잔고 표시
    const cashEl = document.getElementById('stat-cash');
    if (mkt === 'US') {
      // 미국 모드: 통합증거금 — 원화 잔고만 표시 (달러 불필요)
      if (fetching && cashKrwForUs === 0 && !hasQueried) {
        cashEl.textContent = '조회 중…';
      } else if (cashKrwForUs > 0) {
        cashEl.textContent = `${fmtPrice(cashKrwForUs)}원 (통합증거금)`;
      } else if (hasQueried) {
        cashEl.textContent = '0원 (잔고 없음 — ✏️ 입력 필요)';
      } else {
        cashEl.textContent = hasApiKey ? '조회 중…' : '미연결';
      }
    } else if (mkt === 'BOTH') {
      // BOTH 모드: 원화 잔고로 국내+미국 모두 커버 (통합증거금)
      if (fetching && cash === 0 && !hasQueried) {
        cashEl.textContent = '조회 중…';
      } else if (cash > 0) {
        cashEl.textContent = `${fmtPrice(cash)}원 (주문가능현금)`;
      } else if (hasQueried) {
        cashEl.textContent = '0원 (잔고 없음 — ✏️ 입력 필요)';
      } else {
        cashEl.textContent = hasApiKey ? '조회 중…' : '미연결';
      }
    } else {
      // KR 모드
      if (fetching && cash === 0 && !hasQueried) {
        cashEl.textContent = '조회 중…';
      } else if (cash > 0) {
        cashEl.textContent = fmtPrice(cash) + '원';
      } else if (hasQueried) {
        cashEl.textContent = '0원 (잔고 없음 — ✏️ 입력 필요)';
      } else {
        cashEl.textContent = hasApiKey ? '조회 중…' : '미연결';
      }
    }

    // 주식 평가금 표시
    const stockDisplayVal = mkt === 'US' ? stockValUsdKrw : mkt === 'BOTH' ? (stockValKr + stockValUsdKrw) : stockValKr;
    document.getElementById('stat-stock-value').textContent = stockDisplayVal > 0 ? fmtPrice(stockDisplayVal) + '원' : '-';

    // 배지 + 진행 바 (실전)
    document.getElementById('stat-asset-badge').textContent = '실전';
    document.getElementById('stat-asset-badge').className   = 'text-xs px-1.5 py-0.5 rounded bg-red-900/50 text-red-400';

    // 진행 바 (잔고 대비 주식 비중)
    const barEl = document.getElementById('stat-asset-bar');
    if (totalAsset > 0) {
      const barPct = Math.min((stockDisplayVal / totalAsset) * 100, 100);
      barEl.style.width = barPct + '%';
      barEl.className = 'h-0.5 rounded transition-all duration-500 bg-red-400';
    } else {
      barEl.style.width = '0%';
      barEl.className = 'h-0.5 rounded transition-all duration-500 bg-gray-600';
    }
  }

  // ── 오늘 손익 카드 ──────────────────────────────────
  const dailyEl   = document.getElementById('stat-daily-profit');
  dailyEl.textContent = (dailyProfit >= 0 ? '+' : '') + fmtPrice(dailyProfit) + '원';
  dailyEl.className   = 'text-2xl font-bold ' + (dailyProfit >= 0 ? 'text-profit' : 'text-loss');
  const dailyRate = STATE.config.paperCapital > 0 ? (dailyProfit / STATE.config.paperCapital * 100).toFixed(2) : '0.00';
  document.getElementById('stat-daily-rate').textContent = (dailyProfit >= 0 ? '+' : '') + dailyRate + '%';
  // 미실현 손익
  const unrEl = document.getElementById('stat-unrealized');
  unrEl.textContent = (unrealizedPnl >= 0 ? '+' : '') + fmtPrice(unrealizedPnl) + '원';
  unrEl.className   = unrealizedPnl >= 0 ? 'text-green-400 font-medium' : 'text-red-400 font-medium';

  // ── 누적 손익 카드 ──────────────────────────────────
  const profitEl = document.getElementById('stat-total-profit');
  profitEl.textContent = (totalProfit >= 0 ? '+' : '') + fmtPrice(totalProfit) + '원';
  profitEl.className   = 'text-2xl font-bold ' + (totalProfit >= 0 ? 'text-profit' : 'text-loss');
  document.getElementById('stat-win-rate').textContent = winRate + '%';
  document.getElementById('stat-trades').textContent   = totalTrades + '회';

  // ── 포지션 카드 ─────────────────────────────────────
  document.getElementById('stat-positions').textContent = `${curPos} / ${maxPos}`;
  document.getElementById('stat-slots-left').textContent = `${Math.max(maxPos - curPos, 0)}개 여유`;
  document.getElementById('stat-slots-left').className   =
    (maxPos - curPos) > 0 ? 'text-green-400 font-medium' : 'text-red-400 font-medium';
  document.getElementById('maxpos-display').textContent  = maxPos;
  renderPosSlots();
}

// ─── 차트 ─────────────────────────────────────────────────────
let profitChart = null;

function initProfitChart() {
  const ctx = document.getElementById('profit-chart').getContext('2d');
  profitChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels:   ['시작'],
      datasets: [{
        label: '누적 손익 (원)',
        data:  [0],
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.08)',
        borderWidth: 2,
        pointRadius: 3,
        fill: true,
        tension: 0.3,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#6b7280', font: { size: 10 } }, grid: { color: '#1f2937' } },
        y: { ticks: { color: '#6b7280', font: { size: 10 }, callback: v => fmtPrice(v) + '원' }, grid: { color: '#1f2937' } },
      },
    },
  });
}

function updateProfitChart() {
  if (!profitChart) return;
  const history = STATE.profitHistory.slice(-30);
  profitChart.data.labels   = ['시작', ...history.map(h => h.time)];
  profitChart.data.datasets[0].data = [0, ...history.map(h => h.cumProfit)];
  profitChart.data.datasets[0].borderColor = STATE.stats.totalProfit >= 0 ? '#22c55e' : '#ef4444';
  profitChart.update();
}

// ─── 종목 스캐너 UI ───────────────────────────────────────────
async function lookupStock() {
  const input  = document.getElementById('ticker-input').value.trim().replace(/\s/g, '');
  if (!input) { addLog('warn', '⚠️ 종목코드 또는 종목명을 입력하세요'); return; }

  const el = document.getElementById('scanner-result');

  // #8 종목명 검색: 숫자 6자리가 아닌 입력 → 종목명 검색 분기
  const isCode = /^\d{4,6}$/.test(input);
  if (!isCode) {
    // 한글/영문 → 종목명 검색
    el.innerHTML = '<div class="col-span-full text-gray-500 text-sm text-center py-4">🔍 종목명 검색 중...</div>';
    try {
      const res  = await fetch('/api/kis/kr/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: input }),
        signal: AbortSignal.timeout(6000),
      });
      const data = await res.json();
      if (data.ok && data.results && data.results.length > 0) {
        el.innerHTML = data.results.map(r => `
          <div class="scanner-card cursor-pointer" onclick="document.getElementById('ticker-input').value='${r.code}'; lookupStock()">
            <div class="font-medium text-white text-xs truncate">${r.name}</div>
            <div class="text-sm font-bold text-yellow-300 mt-0.5">${r.code}</div>
            <div class="text-xs text-gray-500 mt-0.5">${r.market || 'KR'} · 클릭해서 조회</div>
          </div>`).join('');
        addLog('info', `🔍 "${input}" 검색 결과 ${data.results.length}개`);
      } else {
        el.innerHTML = `<div class="col-span-full text-gray-600 text-sm text-center py-4">검색 결과 없음 — "${input}"</div>`;
        addLog('warn', `⚠️ "${input}" 검색 결과 없음`);
      }
    } catch(e) {
      el.innerHTML = '<div class="col-span-full text-gray-600 text-sm text-center py-4">검색 실패 — 다시 시도하세요</div>';
      addLog('warn', '⚠️ 종목 검색 오류: ' + (e.message || e));
    }
    return;
  }

  // 6자리 코드 → 현재가 조회
  const ticker = input.padStart(6, '0');
  el.innerHTML = '<div class="col-span-full text-gray-500 text-sm text-center py-4">🔄 조회 중...</div>';

  // KIS 우선 조회 (API 키 있을 때), 실패 시 네이버 폴백
  try {
    let d = null;
    let source = '';

    if (KEYS.appKey && KEYS.appSecret) {
      // KIS FHKST01010100
      try {
        const res = await fetch('/api/kis/kr/price', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appKey: KEYS.appKey,
            appSecret: KEYS.appSecret,
            code: ticker,
            kisToken: KEYS.kisToken || undefined,
          }),
        });
        const kisData = await res.json();
        if (kisData.ok && kisData.price > 0) { d = kisData; source = 'KIS'; }
      } catch { /* 네이버 폴백 */ }
    }

    if (!d) {
      // 네이버 폴백 (API 키 없거나 KIS 실패)
      const res = await axios.get(`/api/naver/price/${ticker}`, { timeout: 5000 });
      if (res.data?.ok) { d = res.data; source = '네이버'; }
    }

    if (d) {
      const pct = d.changeRate;
      el.innerHTML = `
        <div class="scanner-card col-span-2">
          <div class="flex justify-between">
            <span class="font-medium text-white text-sm">${d.name || ticker}</span>
            <span class="text-xs text-gray-500">${ticker} · ${d.market || ''}</span>
          </div>
          <div class="text-lg font-bold text-white mt-1">${fmtPrice(d.price)}원</div>
          <div class="${pct >= 0 ? 'text-green-400' : 'text-red-400'} text-sm">${pct >= 0 ? '+' : ''}${pct}%</div>
          <div class="text-xs text-gray-500 mt-1">전일 대비 ${d.change >= 0 ? '+' : ''}${fmtPrice(d.change)}원 · ${source} 실시간</div>
        </div>`;
      addLog('info', `🔍 ${d.name || ticker}: ${fmtPrice(d.price)}원 (${pct >= 0 ? '+' : ''}${pct}%) [${source} 실시간]`);
      return;
    }
  } catch(e) {
    addLog('warn', '⚠️ 종목 조회 실패 — ' + e.message);
  }
  el.innerHTML = '<div class="col-span-full text-gray-600 text-sm text-center py-4">조회 실패 — 종목코드를 확인하세요</div>';
}

async function loadVolumeRank() {
  const el = document.getElementById('scanner-result');
  el.innerHTML = '<div class="col-span-full text-gray-500 text-sm text-center py-4">🔄 거래량 상위 조회 중 (KOSPI+KOSDAQ)...</div>';

  // KOSPI + KOSDAQ 병렬 조회
  try {
    const [kospiRes, kosdaqRes] = await Promise.allSettled([
      axios.get('/api/naver/volume-rank?market=KOSPI&top=20',  { timeout: 10000 }),
      axios.get('/api/naver/volume-rank?market=KOSDAQ&top=20', { timeout: 10000 }),
    ]);
    const kospiList  = kospiRes.status  === 'fulfilled' ? (kospiRes.value.data?.stocks  || []) : [];
    const kosdaqList = kosdaqRes.status === 'fulfilled' ? (kosdaqRes.value.data?.stocks || []) : [];
    // 중복 제거 후 병합, 거래량 기준 정렬 → 상위 12개
    const seen = new Set();
    const merged = [];
    for (const s of [...kospiList, ...kosdaqList]) {
      if (!seen.has(s.code)) { seen.add(s.code); merged.push(s); }
    }
    merged.sort((a, b) => (b.volume || 0) - (a.volume || 0));
    const items = merged.slice(0, 12);
    if (items.length > 0) {
      el.innerHTML = items.map(item => {
        const pct = item.changeRate;
        const mktTag = kosdaqList.some(k => k.code === item.code)
          ? '<span class="text-purple-400">KOSDAQ</span>'
          : '<span class="text-blue-400">KOSPI</span>';
        return `
        <div class="scanner-card" onclick="document.getElementById('ticker-input').value='${item.code}'; lookupStock()">
          <div class="font-medium text-white text-xs truncate">${item.name}</div>
          <div class="text-sm font-bold text-white mt-0.5">${fmtPrice(item.price)}원</div>
          <div class="${pct >= 0 ? 'text-green-400' : 'text-red-400'} text-xs">${pct >= 0 ? '+' : ''}${pct}%</div>
          <div class="text-xs text-gray-600 mt-0.5">${mktTag} · 거래량 ${item.rank}위</div>
        </div>`;
      }).join('');
      addLog('info', `📊 거래량 상위 ${items.length}개 로드 (KOSPI ${kospiList.length} + KOSDAQ ${kosdaqList.length}) [네이버 실시간]`);
      return;
    }
  } catch(e) {
    addLog('warn', '⚠️ 거래량 순위 조회 실패 — ' + e.message);
  }

  // 시뮬레이션 데이터
  const SIM_STOCKS = [
    { ticker: '005930', name: '삼성전자', price: 78000, pct: 1.2, vol: 25000000 },
    { ticker: '000660', name: 'SK하이닉스', price: 195000, pct: -0.8, vol: 8000000 },
    { ticker: '035420', name: 'NAVER', price: 235000, pct: 2.1, vol: 3000000 },
    { ticker: '005380', name: '현대차', price: 265000, pct: 0.5, vol: 2500000 },
    { ticker: '051910', name: 'LG화학', price: 380000, pct: -1.5, vol: 1800000 },
    { ticker: '035720', name: '카카오', price: 48000, pct: 3.2, vol: 15000000 },
    { ticker: '068270', name: '셀트리온', price: 195000, pct: 1.8, vol: 2200000 },
    { ticker: '003670', name: '포스코홀딩스', price: 375000, pct: -0.3, vol: 1200000 },
    { ticker: '207940', name: '삼성바이오로직스', price: 980000, pct: 0.9, vol: 500000 },
    { ticker: '006400', name: '삼성SDI', price: 370000, pct: -2.1, vol: 900000 },
  ];
  el.innerHTML = SIM_STOCKS.map(s => `
    <div class="scanner-card" onclick="document.getElementById('ticker-input').value='${s.ticker}'">
      <div class="font-medium text-white text-xs truncate">${s.name}</div>
      <div class="text-sm font-bold text-white mt-0.5">${fmtPrice(s.price)}원</div>
      <div class="${s.pct >= 0 ? 'text-green-400' : 'text-red-400'} text-xs">${s.pct >= 0 ? '+' : ''}${s.pct}%</div>
      <div class="text-xs text-gray-600 mt-0.5">거래량 ${fmtVolume(s.vol)}</div>
      <div class="text-xs text-yellow-600 mt-0.5">[시뮬레이션]</div>
    </div>
  `).join('');
  addLog('info', '📊 시뮬레이션 거래량 데이터 표시 중 (API 키 설정 시 실시간)');
}

// ─── 장 상태 ──────────────────────────────────────────────────

/**
 * 현재 정규 거래 가능 여부 반환 (09:00~15:30, 평일만)
 * runScan() / scanForEntries() 에서 진입 차단에 사용
 */
// ─── 장 시간 판별 ─────────────────────────────────────────────
// 모든 시간은 브라우저 로컬 시간 기준 (한국 사용자 = KST)

/**
 * ── 시장 시간 판단 유틸 ────────────────────────────────────────────
 * 모든 함수는 브라우저 타임존에 무관하게 명시적 KST(UTC+9) 기준으로 계산.
 * new Date().getHours()는 브라우저 로컬 시간에 의존하므로 사용하지 않음.
 */

/** UTC → KST 변환: { day, h, m, min } 반환 */
function nowKST() {
  const now = new Date();
  // UTC 밀리초 + 9시간 → KST Date 객체
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  // KST 기준 요일 (0=일, 1=월 ... 6=토)
  const day = kst.getUTCDay();
  const h   = kst.getUTCHours();
  const m   = kst.getUTCMinutes();
  return { day, h, m, min: h * 60 + m };
}

/** 국내 정규장 여부 (평일 09:00~15:30 KST) */
function isKrMarketOpen() {
  const { day, min } = nowKST();
  if (day === 0 || day === 6) return false;
  return min >= 9 * 60 && min < 15 * 60 + 30;
}

/** 국내 장 마감 1시간 전 여부 (14:30~15:30 KST) — 보유 포지션 청산 준비 기준 */
function isKrMarketPreClose() {
  const { day, min } = nowKST();
  if (day === 0 || day === 6) return false;
  return min >= 14 * 60 + 30 && min < 15 * 60 + 30;
}

/** 국내 장 마감 30분 전 여부 (15:00~15:30 KST) — 신규 진입 차단 기준 */
function isKrMarketClosingSoon() {
  const { day, min } = nowKST();
  if (day === 0 || day === 6) return false;
  return min >= 15 * 60 && min < 15 * 60 + 30;
}

/**
 * 미국 증시 공휴일 여부 (KST 날짜 기준)
 * KST로 오늘 날짜를 구해서 뉴욕 날짜와 맞춤
 * ※ KST 00:00~14:59 = 전날 뉴욕 날짜 (서머타임 기준)
 *    KST 15:00 이후  = 당일 뉴욕 날짜
 */
function isUsHoliday() {
  // 뉴욕 날짜 계산: UTC - 4시간 (EDT 서머타임 3~11월)
  //                 UTC - 5시간 (EST 표준시 11~3월)
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const kstMonth = kst.getUTCMonth() + 1; // 1~12
  // 서머타임: 3월 두번째 일요일 ~ 11월 첫번째 일요일 (근사)
  const isDST = kstMonth >= 3 && kstMonth <= 11;
  const nyOffset = isDST ? -4 : -5;
  const nyTime = new Date(now.getTime() + nyOffset * 3600 * 1000);
  const m  = nyTime.getUTCMonth() + 1; // 뉴욕 월
  const d  = nyTime.getUTCDate();      // 뉴욕 일
  const wd = nyTime.getUTCDay();       // 뉴욕 요일 (0=일,6=토)

  // 고정 공휴일 (월/일 기준)
  // 1/1 신정, 6/19 준틴스, 7/4 독립기념일, 11/11 재향군인의날*, 12/25 크리스마스
  // (* 재향군인의날은 주식시장 열림 → 제외)
  const fixedHolidays = [
    [1, 1],   // 신정 (New Year's Day)
    [6, 19],  // 준틴스 (Juneteenth)
    [7, 4],   // 독립기념일
    [12, 25], // 크리스마스
  ];
  // 주말 전후 대체공휴일
  // 공휴일이 토요일 → 금요일 대체
  // 공휴일이 일요일 → 월요일 대체
  for (const [hm, hd] of fixedHolidays) {
    if (m === hm && d === hd && wd !== 0 && wd !== 6) return true; // 평일 당일
    // 토요일 → 금요일 대체
    if (m === hm && wd === 5) {
      const nextDay = new Date(nyTime); nextDay.setUTCDate(d + 1);
      if (nextDay.getUTCMonth() + 1 === hm && nextDay.getUTCDate() === hd) return true;
    }
    // 일요일 → 월요일 대체
    if (m === hm && wd === 1) {
      const prevDay = new Date(nyTime); prevDay.setUTCDate(d - 1);
      if (prevDay.getUTCMonth() + 1 === hm && prevDay.getUTCDate() === hd) return true;
    }
  }

  // 변동 공휴일 (요일 기반)
  // MLK Day: 1월 세번째 월요일
  if (m === 1 && wd === 1 && d >= 15 && d <= 21) return true;
  // Presidents Day: 2월 세번째 월요일
  if (m === 2 && wd === 1 && d >= 15 && d <= 21) return true;
  // Memorial Day: 5월 마지막 월요일
  if (m === 5 && wd === 1 && d >= 25) return true;
  // Labor Day: 9월 첫번째 월요일
  if (m === 9 && wd === 1 && d <= 7) return true;
  // Thanksgiving: 11월 네번째 목요일
  if (m === 11 && wd === 4 && d >= 22 && d <= 28) return true;
  // Good Friday: 부활절 금요일 (2025: 4/18, 2026: 4/3)
  // 근사: 3~4월 금요일 중 부활절 전 금요일 (하드코딩)
  const easterFridays = ['2025-04-18', '2026-04-03', '2027-03-26', '2028-04-14'];
  const nyDateStr = `${nyTime.getUTCFullYear()}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  if (easterFridays.includes(nyDateStr)) return true;

  return false;
}

/**
 * 미국 정규장 여부 (KST 기준, 서머타임 대응)
 *  - 서머타임(EDT, 3~11월): 22:30~05:00 KST
 *  - 표준시  (EST, 11~ 3월): 23:30~06:00 KST
 *  ⚠️ 보수적 처리: 22:30 기준으로 통일 (서머타임 기간 = 현재 8월에 맞춤)
 *     표준시 22:30~23:29 사이 TTTT 전송 시 KIS 에러 → 안전하게 차단됨
 *
 *  ✅ 반드시 KST로 계산 — 브라우저 로컬 타임존 무관
 */
function isUsMarketOpen() {
  const { day, min } = nowKST();
  // 일요일 KST: 뉴욕 토요일 낮 = 완전 마감
  if (day === 0) return false;
  // ✅ 미국 공휴일 체크 (MLK Day, Presidents Day, Good Friday 등)
  if (isUsHoliday()) return false;
  // 평일(월~금): KST 22:30~익일05:00
  //   22:30 이후(당일) OR 00:00~05:00(다음날 새벽)
  if (day >= 1 && day <= 5) {
    return min >= 22 * 60 + 30 || min < 5 * 60;
  }
  // 토요일 KST 00:00~05:00: 금요일 뉴욕장 마지막 시간
  if (day === 6) {
    return min < 5 * 60;
  }
  return false;
}

/**
 * 미국 장 마감 30분 전 여부 — 신규 진입 차단 기준 (KST)
 *  - 서머타임(EDT, 3~11월): 04:30~05:00 KST
 *  - 표준시  (EST, 11~ 3월): 05:30~06:00 KST
 *  ⚠️ 현재(8월) 서머타임: 04:30 기준 사용
 *     표준시 기간 대비 여유: 05:30도 포함 (둘 다 커버)
 */
function isUsMarketClosingSoon() {
  const { day, min } = nowKST();
  // 일요일은 장 없음
  if (day === 0) return false;
  // 서머타임 마감 30분 전: 04:30~05:00 KST
  const edtClose = min >= 4 * 60 + 30 && min < 5 * 60;
  // 표준시 마감 30분 전: 05:30~06:00 KST
  const estClose = min >= 5 * 60 + 30 && min < 6 * 60;
  return edtClose || estClose;
}

/** 현재 시장 모드에서 신규 진입 가능한지 (장 마감 30분 전은 false) */
function isMarketOpen() {
  const mkt = STATE.market;
  if (mkt === 'KR')   return isKrMarketOpen();
  if (mkt === 'US')   return isUsMarketOpen();
  if (mkt === 'BOTH') return isKrMarketOpen() || isUsMarketOpen();
  return false;
}

/**
 * 신규 매수 진입 가능 여부 — 장 마감 30분 전이면 false
 * checkPositionsForExit(청산 체크)와 별개로 신규 진입만 차단
 */
function canEnterNewPosition() {
  const mkt = STATE.market;
  if (STATE.mode === 'paper') return true; // 페이퍼는 항상 허용
  // 국내: 14:30(마감 1시간 전)부터 신규 매수 차단
  if (mkt === 'KR')   return isKrMarketOpen() && !isKrMarketPreClose();
  // 미국: 04:30(마감 30분 전)부터 신규 매수 차단
  if (mkt === 'US')   return isUsMarketOpen() && !isUsMarketClosingSoon();
  if (mkt === 'BOTH') {
    const krOk = isKrMarketOpen() && !isKrMarketPreClose();
    const usOk = isUsMarketOpen() && !isUsMarketClosingSoon();
    return krOk || usOk;
  }
  return false;
}

/** 다음 개장 시각 문자열 (KST 기준) */
function getNextOpenStr(forMarket) {
  const { day, min } = nowKST();
  // forMarket 없으면 STATE.market 기준, BOTH는 더 빨리 열리는 쪽
  const mkt = forMarket || STATE.market;

  if (mkt === 'US') {
    // 다음 미국 야간 정규장: 당일 KST 22:30 또는 다음 평일 22:30
    const kstNow = new Date(new Date().getTime() + 9 * 3600 * 1000);
    // 오늘 평일이고 아직 22:30 전이면 오늘 22:30
    const todayUsOpen = (day >= 1 && day <= 5) && min < 22 * 60 + 30;
    const next = new Date(kstNow);
    if (!todayUsOpen) next.setUTCDate(next.getUTCDate() + 1);
    // 주말 건너뜀
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
    const mo = String(next.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(next.getUTCDate()).padStart(2, '0');
    return `${mo}/${dd} 22:30`;
  }

  if (mkt === 'BOTH') {
    // 더 빨리 열리는 쪽 반환
    const kstNow = new Date(new Date().getTime() + 9 * 3600 * 1000);
    // 오늘 KR 개장 가능? (09:00 이전 평일)
    const todayKrOpen = (day >= 1 && day <= 5) && min < 9 * 60;
    // 오늘 US 개장 가능? (22:30 이전 평일)
    const todayUsOpen = (day >= 1 && day <= 5) && min < 22 * 60 + 30;
    if (todayKrOpen) {
      const mo = String(kstNow.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(kstNow.getUTCDate()).padStart(2, '0');
      return `🇰🇷 ${mo}/${dd} 09:00 또는 🇺🇸 ${mo}/${dd} 22:30`;
    }
    if (todayUsOpen) {
      const mo = String(kstNow.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(kstNow.getUTCDate()).padStart(2, '0');
      return `🇺🇸 ${mo}/${dd} 22:30`;
    }
    // 다음 평일 09:00 KR
    const next = new Date(kstNow);
    next.setUTCDate(next.getUTCDate() + 1);
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
    const mo = String(next.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(next.getUTCDate()).padStart(2, '0');
    return `🇰🇷 ${mo}/${dd} 09:00`;
  }

  // KR 기본: 다음 평일 09:00 KST
  const kstNow = new Date(new Date().getTime() + 9 * 3600 * 1000);
  // 오늘 평일이고 09:00 전이면 오늘 09:00
  const todayKrOpen = (day >= 1 && day <= 5) && min < 9 * 60;
  const next = new Date(kstNow);
  if (!todayKrOpen) {
    next.setUTCDate(next.getUTCDate() + 1);
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
  }
  const mo = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${mo}/${dd} 09:00`;
}

function updateMarketStatus() {
  const dot   = document.getElementById('market-dot');
  const label = document.getElementById('market-label');
  if (!dot || !label) return;

  const mkt = STATE.market;
  const krOpen    = isKrMarketOpen();
  const usOpen    = isUsMarketOpen();
  const krPreClose = isKrMarketPreClose();    // 14:30~15:30 — 청산 준비
  const krClosing  = isKrMarketClosingSoon(); // 15:00~15:30 — 신규매수 차단(이미 preClose에 포함)
  const usClosing  = isUsMarketClosingSoon();
  const { h, m: min, day } = nowKST(); // KST 기준
  const isWeekday = day >= 1 && day <= 5;

  if (mkt === 'KR') {
    const preOpen   = isWeekday && h === 8 && min >= 30;
    const afterHour = isWeekday && ((h === 15 && min >= 30) || (h >= 16 && h < 18));
    if (krOpen && krClosing) {
      dot.className = 'w-2 h-2 rounded-full bg-orange-400 running-indicator';
      label.textContent = '⏰ 국내 마감 30분 전 (신규 매수 차단)';
      label.className = 'text-orange-400 text-sm';
    } else if (krOpen && krPreClose) {
      dot.className = 'w-2 h-2 rounded-full bg-yellow-400 running-indicator';
      label.textContent = '⏰ 국내 마감 1시간 전 (신규 매수 차단 · 청산 중)';
      label.className = 'text-yellow-400 text-sm';
    } else if (krOpen) {
      dot.className = 'w-2 h-2 rounded-full bg-green-500 running-indicator';
      label.textContent = '🇰🇷 정규장 (09:00~15:30)';
      label.className = 'text-green-400 text-sm';
    } else if (preOpen) {
      dot.className = 'w-2 h-2 rounded-full bg-yellow-400';
      label.textContent = '🟡 장 전 시간외 (08:30~09:00)';
      label.className = 'text-yellow-400 text-sm';
    } else if (afterHour) {
      dot.className = 'w-2 h-2 rounded-full bg-blue-400';
      label.textContent = '🔵 장 후 시간외 (15:30~18:00)';
      label.className = 'text-blue-400 text-sm';
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-gray-500';
      label.textContent = `⚫ 장 마감 (다음 ${getNextOpenStr('KR')})`;
      label.className = 'text-gray-400 text-sm';
    }
  } else if (mkt === 'US') {
    if (usOpen && usClosing) {
      dot.className = 'w-2 h-2 rounded-full bg-yellow-400 running-indicator';
      label.textContent = '⏰ 미국 마감 30분 전 (신규 매수 차단)';
      label.className = 'text-yellow-400 text-sm';
    } else if (usOpen) {
      dot.className = 'w-2 h-2 rounded-full bg-blue-400 running-indicator';
      label.textContent = '🇺🇸 미국 정규장 (22:30~05:00 KST)';
      label.className = 'text-blue-400 text-sm';
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-gray-500';
      label.textContent = `🇺🇸 미국장 마감 (다음 ${getNextOpenStr('US')})`;
      label.className = 'text-gray-400 text-sm';
    }
  } else { // BOTH
    if (krOpen && usOpen) {
      dot.className = 'w-2 h-2 rounded-full bg-green-400 running-indicator';
      label.textContent = '🌏 국내+미국 동시 개장';
      label.className = 'text-green-400 text-sm';
    } else if (krOpen) {
      const krLbl = krClosing  ? '⏰ 국내 마감 30분 전 (차단)'
                  : krPreClose ? '⏰ 국내 마감 1시간 전 (청산 중)'
                  : '🇰🇷 국내 정규장 (미국 마감)';
      const krCls = (krClosing || krPreClose) ? 'text-yellow-400 text-sm' : 'text-green-400 text-sm';
      dot.className = (krClosing || krPreClose)
        ? 'w-2 h-2 rounded-full bg-yellow-400 running-indicator'
        : 'w-2 h-2 rounded-full bg-green-500 running-indicator';
      label.textContent = krLbl;
      label.className = krCls;
    } else if (usOpen) {
      dot.className = 'w-2 h-2 rounded-full bg-blue-400 running-indicator';
      label.textContent = usClosing ? '⏰ 미국 마감 30분 전 (차단)' : '🇺🇸 미국 정규장 (국내 마감)';
      label.className = usClosing ? 'text-yellow-400 text-sm' : 'text-blue-400 text-sm';
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-gray-500';
      label.textContent = `⚫ 모든 장 마감 (다음 ${getNextOpenStr('BOTH')})`;
      label.className = 'text-gray-400 text-sm';
    }
  }

  // 환율 표시 업데이트
  const fxEl = document.getElementById('fx-rate-display');
  if (fxEl && STATE.market !== 'KR') {
    fxEl.textContent = `$1 = ${fmtPrice(STATE.usdKrw)}원`;
  }
}

// ─── 로그 ────────────────────────────────────────────────────
function addLog(type, msg) {
  const el = document.getElementById('log-area');
  const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const colorClass = {
    info: 'log-info', warn: 'log-warn', error: 'log-error',
    buy: 'log-buy', sell: 'log-sell', scan: 'log-scan',
    profit: 'log-profit', loss: 'log-loss',
  }[type] || 'log-info';

  const line = document.createElement('div');
  line.className = colorClass;
  line.textContent = `[${time}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;

  // 최대 300줄 유지
  while (el.children.length > 300) el.removeChild(el.firstChild);
}

function clearLog() { document.getElementById('log-area').innerHTML = ''; }

// ─── 유틸 ─────────────────────────────────────────────────────
function fmtPrice(n) {
  if (n == null || isNaN(n)) return '0';
  return Math.round(n).toLocaleString('ko-KR');
}

function fmtVolume(n) {
  const v = parseFloat(n || 0);
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '억';
  if (v >= 1e4) return (v / 1e4).toFixed(0) + '만';
  return v.toLocaleString('ko-KR');
}
