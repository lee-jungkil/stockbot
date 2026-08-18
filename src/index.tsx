import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  KV: KVNamespace
  ASSETS: Fetcher  // Cloudflare Pages 정적 자산 바인딩
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// ✅ Cloudflare Pages _worker.js 환경: ASSETS 바인딩으로 정적 파일 서빙
// _worker.js 존재 시 모든 요청이 Worker를 거치므로 ASSETS.fetch()로 정적 파일을 직접 전달
app.use('/static/*', async (c, next) => {
  const url = new URL(c.req.url)
  // ASSETS 바인딩이 있으면 Cloudflare Pages 정적 자산으로 위임
  if (c.env?.ASSETS) {
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw))
  }
  // ASSETS 바인딩 없으면 다음 미들웨어로 패스
  return next()
})

// favicon 직접 응답 (Workers 라우터 우선 처리)
app.get('/favicon.svg', (c) => c.body(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📈</text></svg>',
  200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public,max-age=86400' }
))
app.get('/favicon.ico', (c) => c.redirect('/favicon.svg', 301))

// ─────────────────────────────────────────────
// KIS API 헬퍼 (서버→KIS: 샌드박스에서 차단됨 → 에러 상세 반환)
// ─────────────────────────────────────────────

// ── 인메모리 토큰 캐시 (KV 없을 때 폴백 — Worker 인스턴스 생명주기 동안 유지)
const _tokenCache: Map<string, { token: string; exp: number }> = new Map()
// ── 토큰 발급 진행 중인 Promise 뮤텍스 (동일 키로 동시 요청 시 중복 발급 방지)
const _tokenInflight: Map<string, Promise<{ token: string; error?: string; networkError?: boolean }>> = new Map()
// ── 마지막 토큰 발급 시각 (KIS 1분 1회 제한 — 너무 빠른 재발급 방지)
const _tokenLastIssued: Map<string, number> = new Map()
const TOKEN_ISSUE_COOLDOWN_MS = 62000 // 62초 (KIS 1분 제한 + 여유 2초)

/** 토큰 캐시 무효화 (rt_cd='1' 토큰 만료 시 호출) */
function invalidateKisToken(appKey: string) {
  const cacheKey = 'kis_token_' + appKey.slice(-8)
  _tokenCache.delete(cacheKey)
  _tokenInflight.delete(cacheKey) // 진행 중인 요청도 제거
  // 마지막 발급 시각은 유지 — 재발급도 쿨다운 적용
}

async function getKisToken(env: Bindings & Record<string, string>, appKey: string, appSecret: string, kisToken?: string): Promise<{ token: string; error?: string; networkError?: boolean }> {
  // ✅ 클라이언트가 직접 발급한 토큰을 전달한 경우 → 재발급 없이 즉시 사용
  //    Cloudflare Workers는 인스턴스 간 메모리 비공유 → KV 없으면 매 요청마다 재발급 → Rate Limit
  //    해결: 클라이언트가 토큰을 localStorage에 캐싱 후 모든 요청에 kisToken으로 전송
  if (kisToken && kisToken.length > 50) {
    return { token: kisToken }
  }

  const cacheKey = 'kis_token_' + appKey.slice(-8)

  // 1) KV 캐시 조회
  if (env.KV) {
    const cached = await env.KV.get(cacheKey)
    if (cached) return { token: cached }
  }

  // 2) 인메모리 캐시 조회 (KV 없을 때 폴백 — 토큰 재발급 횟수 제한 방지)
  const memCached = _tokenCache.get(cacheKey)
  if (memCached && Date.now() < memCached.exp) {
    return { token: memCached.token }
  }

  // 3) 동일 키로 이미 토큰 발급 진행 중이면 같은 Promise 대기 (중복 발급 방지)
  //    BOTH 모드에서 KR + US 요청이 동시 도달해도 토큰 발급은 1회만 실행됨
  const inflight = _tokenInflight.get(cacheKey)
  if (inflight) return inflight

  // 4) KIS 토큰 발급 1분 1회 제한 — 마지막 발급 후 62초 이내면 에러 반환 (재발급 차단)
  const lastIssued = _tokenLastIssued.get(cacheKey)
  if (lastIssued && (Date.now() - lastIssued) < TOKEN_ISSUE_COOLDOWN_MS) {
    const waitSec = Math.ceil((TOKEN_ISSUE_COOLDOWN_MS - (Date.now() - lastIssued)) / 1000)
    return { token: '', error: `KIS 인증 오류: 접근토큰 발급 잠시 후 다시 시도하세요(1분당 1회) [서버 쿨다운 ${waitSec}초 남음]`, networkError: false }
  }

  const issuePromise = (async (): Promise<{ token: string; error?: string; networkError?: boolean }> => {
    try {
      const res = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: appKey,
          appsecret: appSecret,
        }),
        // @ts-ignore
        signal: AbortSignal.timeout(8000),
      })
      const data: any = await res.json()
      if (!res.ok || !data.access_token) {
        // KIS 서버에 도달했으나 인증 실패 (잘못된 키 등) → networkError=false
        // ⚠️ Rate Limit 응답이라도 쿨다운 기록 (동일 에러 반복 방지)
        _tokenLastIssued.set(cacheKey, Date.now())
        const kisMsg = data.error_description || data.msg1 || data.message || JSON.stringify(data).slice(0, 120)
        return { token: '', error: `KIS 인증 오류: ${kisMsg}`, networkError: false }
      }
      const token = data.access_token

      // KV에 저장 (있으면)
      if (env.KV) {
        await env.KV.put(cacheKey, token, { expirationTtl: 82800 })
      }
      // 인메모리에도 저장 (KV 없을 때 폴백 — 22.5시간 TTL)
      _tokenCache.set(cacheKey, { token, exp: Date.now() + 82800 * 1000 })
      // ✅ 발급 성공 시각 기록 (1분 쿨다운 기준점)
      _tokenLastIssued.set(cacheKey, Date.now())

      return { token }
    } catch (e: any) {
      const msg = e?.message || String(e)
      if (msg.includes('fetch') || msg.includes('connect') || msg.includes('network') || msg.includes('timeout')) {
        return { token: '', error: '서버→KIS 네트워크 연결 실패 (타임아웃/차단)', networkError: true }
      }
      return { token: '', error: msg }
    } finally {
      // 완료 후 뮤텍스 제거 (다음 요청은 새로 발급 가능)
      _tokenInflight.delete(cacheKey)
    }
  })()

  _tokenInflight.set(cacheKey, issuePromise)
  return issuePromise
}

// ─────────────────────────────────────────────
// 네이버 금융 프록시 헬퍼 (서버→네이버: 정상 작동)
// ─────────────────────────────────────────────

/** 현재가 조회: m.stock.naver.com/api/stock/{code}/basic */
async function naverGetPrice(code: string) {
  try {
    const res = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      // @ts-ignore
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const d: any = await res.json()
    return {
      code,
      name: d.stockName,
      price: parseFloat(d.closePrice?.replace(/,/g, '') || '0'),
      change: parseFloat(d.compareToPreviousClosePrice?.replace(/,/g, '') || '0'),
      changeRate: parseFloat(d.fluctuationsRatio || '0'),
      market: d.stockExchangeName,
      ok: true,
    }
  } catch (e: any) {
    return { error: e?.message || 'fetch error', code }
  }
}

/** 일봉 조회: fchart.stock.naver.com XML 파싱 */
async function naverGetCandles(code: string, count = 30) {
  try {
    const res = await fetch(
      `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=${count}&requestType=0`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        // @ts-ignore
        signal: AbortSignal.timeout(5000),
      }
    )
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const xml = await res.text()
    // <item data="20260810|236000|238500|228500|230000|16327805" />
    const items = [...xml.matchAll(/data="(\d{8})\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)"/g)].map(m => ({
      date:   m[1],
      open:   parseInt(m[2]),
      high:   parseInt(m[3]),
      low:    parseInt(m[4]),
      close:  parseInt(m[5]),
      volume: parseInt(m[6]),
    }))
    return { code, candles: items, ok: true }
  } catch (e: any) {
    return { error: e?.message || 'fetch error', code }
  }
}

/** 거래량 상위 종목: finance.naver.com HTML 파싱 → 코드 목록 → basic API 조회 */
async function naverGetVolumeRank(market: 'KOSPI' | 'KOSDAQ' = 'KOSPI', topN = 20) {
  try {
    const sosok = market === 'KOSPI' ? '0' : '1'
    const res = await fetch(
      `https://finance.naver.com/sise/sise_quant.nhn?sosok=${sosok}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer': 'https://finance.naver.com/',
        },
        // @ts-ignore
        signal: AbortSignal.timeout(8000),
      }
    )
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const html = await res.text()
    // 6자리 숫자 종목코드 추출 (중복 제거)
    const codes = [...new Set([...html.matchAll(/code=(\d{6})/g)].map(m => m[1]))].slice(0, topN)
    if (!codes.length) return { error: '종목 코드 파싱 실패', stocks: [] }

    // 상위 N개 현재가 병렬 조회
    const results = await Promise.all(codes.map(c => naverGetPrice(c)))
    const stocks = results.filter((r: any) => r.ok).map((r: any, i: number) => ({
      rank: i + 1,
      code: r.code,
      name: r.name,
      price: r.price,
      changeRate: r.changeRate,
      market,
    }))
    return { stocks, ok: true }
  } catch (e: any) {
    return { error: e?.message || 'fetch error', stocks: [] }
  }
}

// ─────────────────────────────────────────────
// API 라우트
// ─────────────────────────────────────────────

// ── KIS 프록시: 토큰 발급 (서버→KIS 경유)
app.post('/api/kis/token', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const appKey    = body.appKey    || c.req.header('x-app-key')    || ''
  const appSecret = body.appSecret || c.req.header('x-app-secret') || ''
  if (!appKey || !appSecret) return c.json({ error: 'appKey, appSecret 필수' }, 400)

  const result = await getKisToken({ ...c.env } as any, appKey, appSecret)
  if (!result.token) {
    if (result.networkError) {
      return c.json({
        error: result.error || '네트워크 연결 실패',
        serverBlocked: true,
        hint: '서버→KIS 네트워크 연결 실패입니다. Cloudflare Pages 배포 후 재시도해 주세요.',
      }, 503)
    }
    return c.json({
      error: result.error || 'KIS 인증 실패',
      serverBlocked: false,
      kisReachable: true,
      hint: 'KIS 서버에 정상 연결됐습니다. APP KEY / APP SECRET를 확인하세요.',
    }, 401)
  }
  // ✅ 클라이언트가 토큰을 직접 캐싱할 수 있도록 access_token 반환
  //    클라이언트는 이 토큰을 localStorage에 저장하고 모든 KIS API 요청 시 kisToken으로 전송
  //    서버는 kisToken이 있으면 재발급 없이 그대로 사용 → Rate Limit 완전 해소
  return c.json({ ok: true, kisReachable: true, accessToken: result.token })
})

// ── KIS 프록시: 잔고 조회 (서버→KIS 경유)
app.post('/api/kis/balance', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const { appKey, appSecret, accountNo, kisToken } = body
  if (!appKey || !appSecret || !accountNo) {
    return c.json({ error: 'appKey, appSecret, accountNo 필수' }, 400)
  }

  // 토큰 취득 (최대 2회 시도: 만료 시 캐시 무효화 후 재발급)
  async function fetchBalance(retrying = false): Promise<Response> {
    const { token, error: tokErr } = await getKisToken({ ...c.env } as any, appKey, appSecret, kisToken)
    if (!token) return c.json({ error: tokErr || '토큰 발급 실패', serverBlocked: true }, 503)

    const [cano, acntPrdtCd] = accountNo.split('-')
    const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/trading/inquire-balance?CANO=${cano}&ACNT_PRDT_CD=${acntPrdtCd}&AFHR_FLPR_YN=N&OFL_YN=&INQR_DVSN=02&UNPR_DVSN=01&FUND_STTL_ICLD_YN=N&FNCG_AMT_AUTO_RDPT_YN=N&PRCS_DVSN=00&CTX_AREA_FK100=&CTX_AREA_NK100=`
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: appKey, appsecret: appSecret,
        tr_id: 'TTTC8434R', custtype: 'P',
      },
      // @ts-ignore
      signal: AbortSignal.timeout(8000),
    })
    const data: any = await res.json()
    if (data.rt_cd !== '0') {
      // rt_cd='1': 토큰 만료 → 캐시 무효화 후 1회 재시도
      if (data.rt_cd === '1' && !retrying) {
        invalidateKisToken(appKey)
        if (c.env.KV) await c.env.KV.delete('kis_token_' + appKey.slice(-8)).catch(() => {})
        return fetchBalance(true)
      }
      const errMsg = data.msg1 || data.msg2 || JSON.stringify(data).slice(0, 200)
      const rtCd = data.rt_cd || 'unknown'
      const isAcnoErr = errMsg.includes('INVALID_CHECK_ACNO')
      const hint = rtCd === '1'
        ? '토큰 만료 — 재발급 실패. 잠시 후 재시도'
        : isAcnoErr
          ? '계좌번호 불일치 — APP KEY 발급 시 등록한 계좌번호와 동일하게 입력하세요 (KIS 개발자센터 확인)'
          : `KIS 응답코드 ${rtCd}`
      return c.json({ error: errMsg, rtCd, serverBlocked: false, hint }, 400)
    }
    const out2kr = data?.output2?.[0] || {}
    // ord_psbl_cash: 주문가능현금 (주식 매수 후 차감된 실제 가용현금)
    // dnca_tot_amt:  예수금총액 (매수 전 전체, 이중계산 주의)
    // 우선순위: 주문가능현금 → 예수금총액 순으로 폴백
    const balance = parseFloat(
      out2kr.ord_psbl_cash ||   // 주문가능현금 ← 주식 매수 후 실제 차감됨
      out2kr.prvs_rcdv_amt  ||  // 가수도금액 (D+2 결제 기준)
      out2kr.dnca_tot_amt   ||  // 예수금총액 (폴백)
      '0'
    )
    // 순자산 (현금 + 주식평가금 합산) → 총자산 표시용
    const totalAssetKr = parseFloat(out2kr.tot_evlu_amt || out2kr.nass_amt || '0')
    // output1: 보유 종목 목록 (국내주식)
    const holdings = (data?.output1 || []).map((item: any) => ({
      ticker:     item.pdno,           // 종목코드 (6자리)
      name:       item.prdt_name,      // 종목명
      qty:        parseFloat(item.hldg_qty || '0'),          // 보유수량
      avgPrice:   parseFloat(item.pchs_avg_pric || '0'),     // 평균매수가
      currentPrice: parseFloat(item.prpr || '0'),            // 현재가
      evalAmt:    parseFloat(item.evlu_amt || '0'),          // 평가금액
      pnlPct:     parseFloat(item.evlu_pfls_rt || '0'),      // 평가손익율
      market:     'KR',
    })).filter((h: any) => h.qty > 0)
    return c.json({ ok: true, balance, totalAsset: totalAssetKr, holdings })
  }

  try {
    return await fetchBalance()
  } catch (e: any) {
    return c.json({ error: e?.message || '잔고 조회 실패', serverBlocked: true }, 503)
  }
})

// ── KIS 프록시: 주문 실행 (서버→KIS 경유)
app.post('/api/kis/order', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const { appKey, appSecret, accountNo, ticker, side, qty, kisToken } = body
  // side: 'buy' | 'sell'
  if (!appKey || !appSecret || !accountNo || !ticker || !side || !qty) {
    return c.json({ error: 'appKey, appSecret, accountNo, ticker, side, qty 필수' }, 400)
  }

  // 토큰 취득 + rt_cd='1' 만료 시 1회 자동 재발급 (잔고조회와 동일한 패턴)
  async function doOrder(retrying = false): Promise<Response> {
    const { token, error: tokErr } = await getKisToken({ ...c.env } as any, appKey, appSecret, kisToken)
    if (!token) {
      return c.json({ error: tokErr || '토큰 실패' }, 401)
    }
    const [cano, acntPrdtCd] = accountNo.split('-')
    // ✅ KIS API TR ID 신버전 (2025년 이후)
    // 구버전 TTTC0852U(매수)/TTTC0801U(매도) → 폐기됨
    // 신버전 TTTC0012U(매수)/TTTC0011U(매도) 사용
    const trId = side === 'buy' ? 'TTTC0012U' : 'TTTC0011U'
    try {
      const res = await fetch('https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/trading/order-cash', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
          appkey: appKey, appsecret: appSecret,
          tr_id: trId, custtype: 'P',
        },
        body: JSON.stringify({
          CANO: cano, ACNT_PRDT_CD: acntPrdtCd,
          PDNO: ticker,
          ORD_DVSN: '01',       // 시장가
          ORD_QTY: String(qty),
          ORD_UNPR: '0',
          EXCG_ID_DVSN_CD: 'KRX', // ✅ 신버전 필수 필드 추가
          SLL_TYPE: side === 'sell' ? '01' : '', // 매도유형 (01:일반매도)
        }),
        // @ts-ignore
        signal: AbortSignal.timeout(8000),
      })
      const data: any = await res.json()
      if (data.rt_cd !== '0') {
        const errMsg = data.msg1 || data.msg2 || JSON.stringify(data).slice(0, 200)
        const rtCd   = data.rt_cd || 'unknown'
        // ⚠️ "TR ID가 유효하지 않습니다" = TR ID 오류 (모의계좌에 실전 TR ID 사용 등)
        // → rt_cd=1이라도 토큰 재발급 시도 불필요, 즉시 에러 반환
        const isTrIdError = errMsg.includes('TR ID') || errMsg.includes('tr_id') || errMsg.includes('TRID')
        // rt_cd='1' + TR ID 오류 아닌 경우만 토큰 만료로 간주 → 1회 재발급 시도
        if (data.rt_cd === '1' && !retrying && !isTrIdError) {
          invalidateKisToken(appKey)
          if (c.env.KV) await c.env.KV.delete('kis_token_' + appKey.slice(-8)).catch(() => {})
          return doOrder(true)
        }
        const hint = isTrIdError
          ? `TR ID 오류 — 모의투자 계좌는 TR ID가 다릅니다 (실전:TTTC0012U / 모의:VTTC0012U). API 설정의 계좌번호가 실전계좌인지 확인하세요`
          : rtCd === '1'
            ? '토큰 만료 — 재발급 실패. 봇을 재시작하거나 잠시 후 재시도하세요'
            : errMsg.includes('ACNO') || errMsg.includes('계좌')
              ? '계좌번호 불일치 — KIS 개발자센터에서 APP KEY와 연결된 계좌번호를 확인하세요'
              : errMsg.includes('잔고') || errMsg.includes('부족') || errMsg.includes('LIMIT')
                ? '매수 가능 금액 부족 — 잔고를 확인하세요'
                : `KIS 응답코드 ${rtCd}`
        return c.json({ error: errMsg, rtCd, hint, trId, ticker }, 400)
      }
      const odno = data.output?.odno
      // rt_cd=0 이면 odno 없어도 매도 접수된 것으로 처리 (KIS 야간/시간외 주문은 odno 미반환 케이스 있음)
      // odno 없으면 ordNo='' 로 반환하되 ok:true — 클라이언트에서 경고 로그만 남김
      return c.json({ ok: true, ordNo: odno || '', trId, odnoMissing: !odno })
    } catch (e: any) {
      const msg = e?.message || '주문 실패'
      const isNetwork = msg.includes('fetch') || msg.includes('connect') || msg.includes('timeout') || msg.includes('network')
      return c.json({ error: msg, serverBlocked: isNetwork }, isNetwork ? 503 : 500)
    }
  }

  return doOrder()
})

// ── KIS 프록시: 미국주식 현재가 (서버→KIS HHDFS00000300)
app.post('/api/kis/us/price', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const { appKey, appSecret, symbol, excd, kisToken } = body
  // excd: NAS=나스닥, NYS=뉴욕, AMS=아멕스
  if (!appKey || !appSecret || !symbol) {
    return c.json({ error: 'appKey, appSecret, symbol 필수' }, 400)
  }
  const { token, error, networkError } = await getKisToken({ ...c.env } as any, appKey, appSecret, kisToken)
  if (!token) {
    return c.json({ error: error || '토큰 실패', serverBlocked: !!networkError }, networkError ? 503 : 401)
  }
  try {
    const exchCd = (excd || 'NAS').toUpperCase()
    const url = `https://openapi.koreainvestment.com:9443/uapi/overseas-price/v1/quotations/price?AUTH=&EXCD=${exchCd}&SYMB=${symbol}`
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: appKey, appsecret: appSecret,
        tr_id: 'HHDFS00000300', custtype: 'P',
      },
      // @ts-ignore
      signal: AbortSignal.timeout(8000),
    })
    const data: any = await res.json()
    if (data.rt_cd !== '0') return c.json({ error: data.msg1 || JSON.stringify(data) }, 400)
    const out = data.output || {}
    return c.json({
      ok: true,
      symbol,
      name: out.rsym || symbol,
      price: parseFloat(out.last || '0'),       // 현재가 (달러)
      change: parseFloat(out.diff || '0'),       // 전일 대비
      changeRate: parseFloat(out.rate || '0'),   // 등락률 %
      volume: parseInt(out.tvol || '0'),         // 거래량
      high: parseFloat(out.high || '0'),
      low: parseFloat(out.low || '0'),
    })
  } catch (e: any) {
    return c.json({ error: e?.message || '미국주식 현재가 조회 실패', serverBlocked: true }, 503)
  }
})

// ── KIS 프록시: 미국주식 복수종목 배치 현재가 조회 (토큰 1회 발급 후 순차 처리)
// CF Workers 다중 인스턴스 문제 해결 — 같은 Worker 인스턴스에서 토큰 1회만 발급
app.post('/api/kis/us/prices', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const { appKey, appSecret, accountNo, kisToken } = body
  // symbols: [{ ticker: 'AAPL', excd: 'NAS' }, ...] — 최대 10개로 제한 (KIS 초당 1회 rate limit)
  const symbolsRaw: Array<{ticker:string; excd:string}> = Array.isArray(body.symbols) ? body.symbols : []
  const symbols = symbolsRaw.slice(0, 10)  // 최대 10개 — 10초 이내 완료
  // accountNo: 선택 — 전달 시 잔고도 함께 조회 (토큰 1회 공유)
  if (!appKey || !appSecret || symbols.length === 0) {
    return c.json({ error: 'appKey, appSecret, symbols[] 필수' }, 400)
  }
  // ── 토큰 1회만 발급 — 시세 + 잔고 모두 이 토큰으로 처리
  const { token, error, networkError } = await getKisToken({ ...c.env } as any, appKey, appSecret, kisToken)
  if (!token) {
    return c.json({ error: error || '토큰 실패', serverBlocked: !!networkError }, networkError ? 503 : 401)
  }
  const results: Array<{
    ticker: string; excd: string; price: number;
    change: number; changeRate: number; volume: number;
    high: number; low: number;
  }> = []
  // ── 순차 처리: KIS 해외주식 초당 1회 Rate Limit 준수
  // 종목당 1.1초 딜레이 삽입 (첫 종목은 딜레이 없음)
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i]
    if (i > 0) await sleep(1100)  // 초당 1회 제한 — 1.1초 간격
    try {
      const exchCd = (s.excd || 'NAS').toUpperCase()
      const url = `https://openapi.koreainvestment.com:9443/uapi/overseas-price/v1/quotations/price?AUTH=&EXCD=${exchCd}&SYMB=${s.ticker}`
      const res = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          appkey: appKey, appsecret: appSecret,
          tr_id: 'HHDFS00000300', custtype: 'P',
        },
        // @ts-ignore
        signal: AbortSignal.timeout(8000),
      })
      const data: any = await res.json()
      if (data.rt_cd === '0') {
        const out = data.output || {}
        results.push({
          ticker:     s.ticker,
          excd:       s.excd || 'NAS',
          price:      parseFloat(out.last || '0'),
          change:     parseFloat(out.diff || '0'),
          changeRate: parseFloat(out.rate || '0'),
          volume:     parseInt(out.tvol || '0'),
          high:       parseFloat(out.high || '0'),
          low:        parseFloat(out.low  || '0'),
        })
      }
    } catch { /* 개별 종목 타임아웃·오류 시 스킵 */ }
  }

  // ── 잔고 조회 (accountNo 전달 시) — 같은 토큰 재사용, 추가 발급 없음
  let balance: { cashUsd: number; cashKrw: number; totalUsd: number } | null = null
  if (accountNo) {
    try {
      const [cano, acntPrdtCd] = String(accountNo).split('-')
      const balUrl = `https://openapi.koreainvestment.com:9443/uapi/overseas-stock/v1/trading/inquire-balance?CANO=${cano}&ACNT_PRDT_CD=${acntPrdtCd}&OVRS_EXCG_CD=NASD&TR_CRCY_CD=USD&CTX_AREA_FK200=&CTX_AREA_NK200=`
      const balRes = await fetch(balUrl, {
        headers: {
          authorization: `Bearer ${token}`,
          appkey: appKey, appsecret: appSecret,
          tr_id: 'TTTS3012R', custtype: 'P',
        },
        // @ts-ignore
        signal: AbortSignal.timeout(8000),
      })
      const balData: any = await balRes.json()
      if (balData.rt_cd === '0') {
        const out2 = balData.output2?.[0] || {}
        const out3 = balData.output3 || {}
        // 달러 현금: 여러 필드명 시도 (계좌 종류에 따라 다름)
        const cashUsd = parseFloat(
          out2.frcr_dncl_amt_2 || out2.frcr_evlu_amt || out2.ovrs_cblc_amt ||
          out3.frcr_dncl_amt_2 || '0'
        )
        // 통합증거금 원화: 가능한 모든 필드명 시도
        const cashKrw = parseFloat(
          out3.wdrw_psbl_tot_amt ||   // 출금가능 총금액
          out3.tot_dncl_amt ||         // 총 예수금
          out3.nass_amt ||             // 순자산금액
          out2.evlu_pfls_amt ||        // 통합증거금 관련
          out3.frcr_buy_amt_smtl1 ||  // 해외주식 매수가능금액(원화) — 일부 계좌
          out3.frcr_use_psbl_amt ||   // 외화사용가능금액
          '0'
        )
        balance = {
          cashUsd,
          cashKrw,
          totalUsd: parseFloat(out3.frcr_evlu_tota || out2.tot_evlu_amt || '0'),
        }
      } else {
        balance = { cashUsd: -1, cashKrw: -1, totalUsd: 0 } // 오류 표시용 (-1)
      }
    } catch { /* 잔고 조회 실패 시 null 유지 */ }
  }

  return c.json({ ok: true, results, balance })
})

// ── KIS 프록시: 미국주식 잔고 조회
app.post('/api/kis/us/balance', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const { appKey, appSecret, accountNo, kisToken } = body
  if (!appKey || !appSecret || !accountNo) {
    return c.json({ error: 'appKey, appSecret, accountNo 필수' }, 400)
  }

  async function fetchUsBalance(retrying = false): Promise<Response> {
    const { token, error: tokErr, networkError } = await getKisToken({ ...c.env } as any, appKey, appSecret, kisToken)
    if (!token) {
      return c.json({ error: tokErr || '토큰 실패', serverBlocked: !!networkError }, networkError ? 503 : 401)
    }
    const [cano, acntPrdtCd] = accountNo.split('-')
    // OVRS_EXCG_CD='' → 전체 거래소(NASD+NYSE+AMEX) 보유종목 한 번에 조회
    const url = `https://openapi.koreainvestment.com:9443/uapi/overseas-stock/v1/trading/inquire-balance?CANO=${cano}&ACNT_PRDT_CD=${acntPrdtCd}&OVRS_EXCG_CD=&TR_CRCY_CD=USD&CTX_AREA_FK200=&CTX_AREA_NK200=`
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: appKey, appsecret: appSecret,
        tr_id: 'TTTS3012R', custtype: 'P',
      },
      // @ts-ignore
      signal: AbortSignal.timeout(8000),
    })
    const data: any = await res.json()
    if (data.rt_cd !== '0') {
      // rt_cd='1': 토큰 만료 → 캐시 무효화 후 1회 재시도
      if (data.rt_cd === '1' && !retrying) {
        invalidateKisToken(appKey)
        if (c.env.KV) await c.env.KV.delete('kis_token_' + appKey.slice(-8)).catch(() => {})
        return fetchUsBalance(true)
      }
      const errMsg = data.msg1 || data.msg2 || JSON.stringify(data).slice(0, 200)
      const rtCd = data.rt_cd || 'unknown'
      const isAcnoErrUs = errMsg.includes('INVALID_CHECK_ACNO')
      const hintUs = isAcnoErrUs
        ? '계좌번호 불일치 — APP KEY 발급 시 등록한 계좌번호와 동일하게 입력하세요'
        : `미국주식 잔고 KIS 응답코드 ${rtCd}`
      return c.json({ error: errMsg, rtCd, serverBlocked: false, hint: hintUs }, 400)
    }
    // output2[0]: 달러 잔고 필드 (여러 필드명 시도)
    const out2 = data.output2?.[0] || {}
    const out3 = data.output3 || {}
    const cashUsd = parseFloat(out2.frcr_dncl_amt_2 || out2.frcr_evlu_amt || out2.ovrs_cblc_amt || out3.frcr_dncl_amt_2 || '0')
    // 통합증거금 계좌: 원화로 해외주식 매수 가능 — 가능한 모든 필드명 시도
    const cashKrw = parseFloat(
      out3.wdrw_psbl_tot_amt ||   // 출금가능 총금액
      out3.tot_dncl_amt ||         // 총 예수금
      out3.nass_amt ||             // 순자산금액
      out3.frcr_buy_amt_smtl1 ||  // 해외주식 매수가능금액(원화)
      out3.frcr_use_psbl_amt ||   // 외화사용가능금액
      '0'
    )
    // output1: 보유 종목 목록 (미국주식)
    const holdingsUs = (data?.output1 || []).map((item: any) => ({
      ticker:       item.ovrs_pdno,           // 종목코드 (예: AAPL)
      name:         item.ovrs_item_name,       // 종목명
      qty:          parseFloat(item.ovrs_cblc_qty || item.hldg_qty || '0'),     // 보유수량
      avgPrice:     parseFloat(item.pchs_avg_pric || '0'),                       // 평균매수가(달러)
      currentPrice: parseFloat(item.now_pric2 || item.ovrs_stck_evlu_amt || '0'), // 현재가(달러)
      evalAmt:      parseFloat(item.ovrs_stck_evlu_amt || '0'),                  // 평가금액(달러)
      pnlPct:       parseFloat(item.evlu_pfls_rt || '0'),                        // 평가손익율
      excd:         item.ovrs_excg_cd || '',   // 거래소코드 (NASD/NYSE)
      market:       'US',
    })).filter((h: any) => h.qty > 0)
    return c.json({ ok: true, cashUsd, cashKrw, totalUsd: parseFloat(out3.frcr_evlu_tota || out2.tot_evlu_amt || '0'), holdings: holdingsUs })
  }

  try {
    return await fetchUsBalance()
  } catch (e: any) {
    return c.json({ error: e?.message || '미국주식 잔고 조회 실패', serverBlocked: true }, 503)
  }
})

// ── KIS 프록시: 미국주식 주문 (시간대 자동 선택 + 서머타임 대응)
app.post('/api/kis/us/order', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const { appKey, appSecret, accountNo, symbol, excd, side, qty, price, kisToken } = body
  if (!appKey || !appSecret || !accountNo || !symbol || !side || !qty || !price) {
    return c.json({ error: 'appKey, appSecret, accountNo, symbol, side, qty, price 필수' }, 400)
  }

  // 토큰 만료 시 1회 자동 재발급 (국내 주문과 동일한 패턴)
  async function doUsOrder(retrying = false): Promise<Response> {
    const { token, error, networkError } = await getKisToken({ ...c.env } as any, appKey, appSecret, kisToken)
    if (!token) {
      return c.json({ error: error || '토큰 실패', serverBlocked: !!networkError }, networkError ? 503 : 401)
    }
    try {
      const [cano, acntPrdtCd] = accountNo.split('-')
      const rawCd = (excd || 'NASD').toUpperCase()
      const exchCd = (rawCd === 'NAS' || rawCd === 'NASD') ? 'NASD'
                   : (rawCd === 'NYS' || rawCd === 'NYSE') ? 'NYSE'
                   : rawCd

      // ── 서버 시간 검증: 장외 시간 주문 차단 ────────────────────────────
      // KST = UTC+9 기준으로 계산
      const nowKst = new Date(Date.now() + 9 * 3600 * 1000)
      const hhmm = nowKst.getUTCHours() * 100 + nowKst.getUTCMinutes()
      const kstDay = nowKst.getUTCDay() // 0=일, 6=토

      // 미국 정규장 여부 (서머타임 기준 22:30~05:00 KST, 표준시 23:30~06:00)
      const kstMin = nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes()
      const isUsRegularSession = (() => {
        if (kstDay === 0) return false  // 일요일
        if (kstDay >= 1 && kstDay <= 5) return kstMin >= 22 * 60 + 30 || kstMin < 5 * 60
        if (kstDay === 6) return kstMin < 5 * 60  // 토요일 새벽 (금요일 마감 전)
        return false
      })()
      // 프리마켓 여부: 18:00~22:29 KST
      const isPremarket = (hhmm >= 1800 && hhmm < 2230)
      // 주간거래 여부: 10:00~17:59 KST (미국 기업 발표 등)
      const isDaytime = (hhmm >= 1000 && hhmm < 1800)

      // 정규장/프리마켓/주간거래 모두 아닌 경우 = 진짜 장외 시간 → 매수/매도 모두 차단
      // KIS는 장외시간 주문을 거부하므로 서버에서 먼저 차단
      if (!isUsRegularSession && !isPremarket && !isDaytime) {
        return c.json({
          error: `미국주식 장외 시간 주문 차단 [KST ${String(nowKst.getUTCHours()).padStart(2,'0')}:${String(nowKst.getUTCMinutes()).padStart(2,'0')} hhmm=${hhmm} side=${side}]`,
          hhmm, kstDay, isUsRegularSession, isPremarket, isDaytime, offHours: true,
        }, 400)
      }

      // ── tr_id 시간대 분기 (서머타임 대응) ──────────────────────────────
      // 서머타임(EDT, 3~11월): 미국 정규장 22:30~05:00 KST
      // 표준시  (EST, 11~3월): 미국 정규장 23:30~06:00 KST
      //
      // 프리마켓(야간): 18:00~22:29 → TTTS 계열
      // 정규장+주간:    22:30~05:00(서머) / 23:30~06:00(표준) + 10:00~17:59 → TTTT 계열
      //
      // ✅ 22:30 기준으로 TTTT 사용 → 서머타임(현재 8~10월) 완벽 대응
      //    표준시 22:30~23:29에 TTTT 전송 시 KIS 에러 → catch→false → 포지션 유지(안전)
      // (nowKst, hhmm, isPremarket은 위 시간 검증 블록에서 이미 선언됨)

      let trId: string
      if (isPremarket) {
        trId = (exchCd === 'NYSE')
          ? (side === 'buy' ? 'TTTS0305U' : 'TTTS0304U')
          : (side === 'buy' ? 'TTTS0308U' : 'TTTS0307U')
      } else {
        // 정규장(22:30~) + 주간거래(10:00~17:59)
        trId = side === 'buy' ? 'TTTT1002U' : 'TTTT1006U'
      }

      const res = await fetch('https://openapi.koreainvestment.com:9443/uapi/overseas-stock/v1/trading/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
          appkey: appKey, appsecret: appSecret,
          tr_id: trId, custtype: 'P',
        },
        body: JSON.stringify({
          CANO: cano, ACNT_PRDT_CD: acntPrdtCd,
          OVRS_EXCG_CD: exchCd,
          PDNO: symbol,
          ORD_DVSN: '00',          // 지정가
          ORD_QTY: String(qty),
          OVRS_ORD_UNPR: String(price),
          SLL_TYPE: side === 'sell' ? '00' : '',  // ✅ 매도 필수 필드 (빈값=매수, '00'=매도)
          ORD_SVR_DVSN_CD: '0',
        }),
        // @ts-ignore
        signal: AbortSignal.timeout(8000),
      })
      const data: any = await res.json()
      if (data.rt_cd !== '0') {
        const errMsg = data.msg1 || data.msg2 || JSON.stringify(data).slice(0, 200)
        const isTrIdError = errMsg.includes('TR ID') || errMsg.includes('tr_id') || errMsg.includes('TRID')
        // 토큰 만료 → 캐시 무효화 후 1회 재시도 (TR ID 오류는 재시도 불필요)
        if (data.rt_cd === '1' && !retrying && !isTrIdError) {
          invalidateKisToken(appKey)
          if (c.env.KV) await c.env.KV.delete('kis_token_' + appKey.slice(-8)).catch(() => {})
          return doUsOrder(true)
        }
        const hint = isTrIdError
          ? `TR ID 오류 — 모의투자 계좌는 TR ID가 다릅니다 (실전:TTTT1002U/TTTT1006U). API 설정의 계좌번호가 실전계좌인지 확인하세요`
          : data.rt_cd === '1' ? '토큰 만료 — 재발급 실패. 봇을 재시작하거나 잠시 후 재시도하세요' : undefined
        return c.json({ error: errMsg, trId, exchCd, hhmm, isPremarket, rt_cd: data.rt_cd, ...(hint ? { hint } : {}) }, 400)
      }
      const odno = data.output?.odno
      // rt_cd=0 이면 odno 없어도 매도 접수된 것으로 처리 (KIS 야간/시간외 주문은 odno 미반환 케이스 있음)
      // odno 없으면 ordNo='' 로 반환하되 ok:true — 클라이언트에서 경고 로그만 남김
      return c.json({ ok: true, ordNo: odno || '', trId, exchCd, hhmm, isPremarket, odnoMissing: !odno })
    } catch (e: any) {
      return c.json({ error: e?.message || '미국주식 주문 실패', serverBlocked: true }, 503)
    }
  }

  return doUsOrder()
})

// ── KIS 프록시: 국내주식 체결 확인 (TTTC0081R — 신버전)
app.post('/api/kis/confirm', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const { appKey, appSecret, accountNo, ordNo, ticker, kisToken } = body
  if (!appKey || !appSecret || !accountNo || !ordNo) {
    return c.json({ error: 'appKey, appSecret, accountNo, ordNo 필수' }, 400)
  }
  const { token, error, networkError } = await getKisToken({ ...c.env } as any, appKey, appSecret, kisToken)
  if (!token) return c.json({ error: error || '토큰 실패', serverBlocked: !!networkError }, networkError ? 503 : 401)

  try {
    const [cano, acntPrdtCd] = accountNo.split('-')
    // TTTC0081R: 주식 일별주문체결조회 (신버전 — 구버전 TTTC8001R 폐기)
    const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/trading/inquire-daily-ccld?CANO=${cano}&ACNT_PRDT_CD=${acntPrdtCd}&INQR_STRT_DT=${new Date(Date.now()+9*3600*1000).toISOString().slice(0,10).replace(/-/g,'')}&INQR_END_DT=${new Date(Date.now()+9*3600*1000).toISOString().slice(0,10).replace(/-/g,'')}&SLL_BUY_DVSN_CD=00&INQR_DVSN=00&PDNO=${ticker||''}&CCLD_DVSN=00&ORD_GNO_BRNO=&ODNO=${ordNo}&INQR_DVSN_3=00&INQR_DVSN_1=&CTX_AREA_FK100=&CTX_AREA_NK100=`
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: appKey, appsecret: appSecret,
        tr_id: 'TTTC0081R', custtype: 'P',
      },
      // @ts-ignore
      signal: AbortSignal.timeout(8000),
    })
    const data: any = await res.json()
    if (data.rt_cd !== '0') {
      return c.json({ error: data.msg1 || JSON.stringify(data).slice(0,200), rtCd: data.rt_cd }, 400)
    }
    const items = (data.output1 || []).map((item: any) => ({
      ordNo:      item.odno,
      ticker:     item.pdno,
      name:       item.prdt_name,
      side:       item.sll_buy_dvsn_cd === '01' ? 'buy' : 'sell',
      ordQty:     parseInt(item.ord_qty || '0'),
      ccldQty:    parseInt(item.tot_ccld_qty || '0'),   // 총 체결수량
      remainQty:  parseInt(item.rmn_qty || '0'),         // 잔여수량
      ccldAmt:    parseFloat(item.tot_ccld_amt || '0'),  // 총 체결금액
      ccldPrice:  parseFloat(item.avg_prvs || item.ccld_unpr3 || '0'), // 평균체결가
      status:     item.tot_ccld_qty === item.ord_qty ? 'filled' : parseInt(item.tot_ccld_qty || '0') > 0 ? 'partial' : 'pending',
    }))
    const filled  = items.find((i: any) => i.ordNo === ordNo)
    return c.json({ ok: true, items, filled: filled || null })
  } catch (e: any) {
    return c.json({ error: e?.message || '체결 조회 실패', serverBlocked: true }, 503)
  }
})

// ── KIS 프록시: 미국주식 체결 확인 (TTTS3035R)
app.post('/api/kis/us/confirm', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const { appKey, appSecret, accountNo, ordNo, kisToken } = body
  if (!appKey || !appSecret || !accountNo || !ordNo) {
    return c.json({ error: 'appKey, appSecret, accountNo, ordNo 필수' }, 400)
  }
  const { token, error, networkError } = await getKisToken({ ...c.env } as any, appKey, appSecret, kisToken)
  if (!token) return c.json({ error: error || '토큰 실패', serverBlocked: !!networkError }, networkError ? 503 : 401)

  try {
    const [cano, acntPrdtCd] = accountNo.split('-')
    const today = new Date(Date.now()+9*3600*1000).toISOString().slice(0,10).replace(/-/g,'')
    // TTTS3035R: 해외주식 체결내역조회
    const url = `https://openapi.koreainvestment.com:9443/uapi/overseas-stock/v1/trading/inquire-ccnl?CANO=${cano}&ACNT_PRDT_CD=${acntPrdtCd}&PDNO=&ORD_STRT_DT=${today}&ORD_END_DT=${today}&SLL_BUY_DVSN=00&CCLD_NCCS_DVSN=00&OVRS_EXCG_CD=&SORT_SQN=DS&ORD_DT=&ORD_GNO_BRNO=&ODNO=${ordNo}&CTX_AREA_FK200=&CTX_AREA_NK200=`
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: appKey, appsecret: appSecret,
        tr_id: 'TTTS3035R', custtype: 'P',
      },
      // @ts-ignore
      signal: AbortSignal.timeout(8000),
    })
    const data: any = await res.json()
    if (data.rt_cd !== '0') {
      return c.json({ error: data.msg1 || JSON.stringify(data).slice(0,200), rtCd: data.rt_cd }, 400)
    }
    const items = (data.output1 || []).map((item: any) => ({
      ordNo:      item.odno,
      ticker:     item.pdno,
      name:       item.prdt_name,
      side:       item.sll_buy_dvsn_cd === '02' ? 'buy' : 'sell',
      ordQty:     parseInt(item.ft_ord_qty || '0'),
      ccldQty:    parseInt(item.ft_ccld_qty || '0'),    // 체결수량
      ccldPrice:  parseFloat(item.ft_ccld_unpr3 || '0'), // 체결단가(달러)
      ccldAmt:    parseFloat(item.ft_ccld_amt2 || '0'),  // 체결금액
      status:     parseInt(item.ft_ccld_qty || '0') > 0 ? 'filled' : 'pending',
    }))
    const filled = items.find((i: any) => i.ordNo === ordNo)
    return c.json({ ok: true, items, filled: filled || null })
  } catch (e: any) {
    return c.json({ error: e?.message || '미국 체결 조회 실패', serverBlocked: true }, 503)
  }
})

// ── 환율 조회 프록시 (한국은행 API → 원/달러 환율)
app.get('/api/forex/usd-krw', async (c) => {
  try {
    // 네이버 금융 환율 프록시
    const res = await fetch('https://m.stock.naver.com/front-api/v1/marketIndex/info?category=exchange&marketIndexCategoryCode=FX', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      // @ts-ignore
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const d: any = await res.json()
      const usdItem = (d?.result?.list || []).find((x: any) => x.itemCode === 'FX_USDKRW' || x.symbolCode === 'FX_USDKRW')
      if (usdItem) {
        return c.json({
          ok: true,
          rate: parseFloat(usdItem.closePrice?.replace(/,/g, '') || usdItem.nav?.replace(/,/g, '') || '1380'),
          source: 'naver',
        })
      }
    }
  } catch {}
  // 폴백: 네이버 환율 직접 조회
  try {
    const res2 = await fetch('https://finance.naver.com/marketindex/', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.naver.com/' },
      // @ts-ignore
      signal: AbortSignal.timeout(5000),
    })
    if (res2.ok) {
      const html = await res2.text()
      // <span class="value">1,380.00</span> 패턴
      const m = html.match(/USD.*?<span[^>]*class="value"[^>]*>([\d,\.]+)<\/span>/s)
      if (m) {
        return c.json({ ok: true, rate: parseFloat(m[1].replace(/,/g, '')), source: 'naver_html' })
      }
    }
  } catch {}
  // 최종 폴백: 고정값
  return c.json({ ok: true, rate: 1380, source: 'fallback' })
})

// ── KIS 토큰 발급 (레거시 경로 — 하위 호환)
app.post('/api/auth/token', async (c) => {
  const { appKey, appSecret } = await c.req.json().catch(() => ({})) as any
  if (!appKey || !appSecret) return c.json({ error: 'appKey, appSecret 필수' }, 400)
  const result = await getKisToken({ ...c.env } as any, appKey, appSecret)
  if (!result.token) {
    return c.json({
      error: result.error || '토큰 발급 실패',
      serverBlocked: true,
      hint: 'Cloudflare Pages 배포 후 서버 프록시 모드를 사용해 주세요',
    }, 503)
  }
  return c.json({ ok: true })
})

// ── KIS 국내주식 현재가 (FHKST01010100) — KIS 우선, 실패 시 네이버 폴백
// POST /api/kis/kr/price  { appKey, appSecret, code, kisToken? }
// KIS FHKST01010100 우선 → 실패 시 네이버 폴백
app.post('/api/kis/kr/price', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const { appKey, appSecret, code, kisToken } = body
  if (!appKey || !appSecret || !code) {
    return c.json({ error: 'appKey, appSecret, code 필수' }, 400)
  }

  // ── 네이버 폴백 헬퍼
  async function naverFallback(reason: string) {
    const fallback = await naverGetPrice(code)
    if ((fallback as any).ok) return c.json({ ...(fallback as any), source: 'naver_fallback' })
    return c.json({ error: reason, serverBlocked: false }, 400)
  }

  // ── KIS 토큰 취득
  const { token, error: tokErr, networkError } = await getKisToken({ ...c.env } as any, appKey, appSecret, kisToken)
  if (!token) {
    // 네트워크 차단이면 503, 인증 오류면 네이버 폴백
    if (networkError) return c.json({ error: tokErr || '네트워크 연결 실패', serverBlocked: true }, 503)
    return naverFallback(tokErr || '토큰 발급 실패')
  }

  // ── KIS 현재가 조회 (최대 2회: 토큰 만료 시 재시도)
  async function fetchPrice(retrying = false): Promise<Response> {
    const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price`
      + `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`
    try {
      const res = await fetch(url, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: 'FHKST01010100',
          custtype: 'P',
        },
        // @ts-ignore
        signal: AbortSignal.timeout(6000),
      })
      const data: any = await res.json()
      const rtCd = data?.rt_cd

      // 토큰 만료 → 캐시 무효화 후 1회 재시도
      if (rtCd === '1' && !retrying) {
        invalidateKisToken(appKey)
        return fetchPrice(true)
      }
      if (rtCd !== '0') {
        // KIS 응답 오류 → 네이버 폴백
        return naverFallback(data?.msg1 || `KIS 오류 rt_cd=${rtCd}`)
      }
      const out = data?.output || {}
      return c.json({
        ok: true,
        code,
        name: out.hts_kor_isnm || '',
        price: parseFloat(out.stck_prpr || '0'),   // 현재가
        change: parseFloat(out.prdy_vrss || '0'),  // 전일 대비
        changeRate: parseFloat(out.prdy_ctrt || '0'), // 등락률(%)
        volume: parseInt(out.acml_vol || '0'),     // 누적거래량
        high: parseFloat(out.stck_hgpr || '0'),
        low: parseFloat(out.stck_lwpr || '0'),
        open: parseFloat(out.stck_oprc || '0'),
        market: out.rprs_mrkt_kor_name || 'KR',
        source: 'kis',
      })
    } catch (e: any) {
      return naverFallback(e?.message || 'KIS fetch 실패')
    }
  }

  return fetchPrice()
})

// ── 종목명 검색: 한글/영문 → 종목코드 목록 반환 (네이버 자동완성 활용)
// POST /api/kis/kr/search  { query: '삼성전자' }
app.post('/api/kis/kr/search', async (c) => {
  const body  = await c.req.json().catch(() => ({}))
  const query = (body.query || '').trim()
  if (!query) return c.json({ ok: false, error: 'query required' }, 400)

  try {
    // 네이버 증권 자동완성 API (인증 불필요)
    const url = `https://ac.stock.naver.com/ac?q=${encodeURIComponent(query)}&target=stock,index,fund,etf`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.naver.com/' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`naver ac ${res.status}`)
    const data: any = await res.json()
    // 응답: { items: [{code, name, typeCode(KOSPI/KOSDAQ), ...}, ...] }
    const items = data?.items || []
    const results = items
      .filter((it: any) => it.code && it.name && it.category === 'stock')
      .slice(0, 10)
      .map((it: any) => ({
        code:   String(it.code).padStart(6, '0'),
        name:   String(it.name),
        market: String(it.typeCode || it.typeName || ''),
      }))
    return c.json({ ok: true, results })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'search failed' }, 500)
  }
})

// ── 네이버 금융 프록시: 현재가 (API 키 불필요 — 폴백용으로 유지)
app.get('/api/naver/price/:code', async (c) => {
  const data = await naverGetPrice(c.req.param('code'))
  return c.json(data)
})

// ── 네이버 금융 프록시: 일봉 차트 (API 키 불필요)
app.get('/api/naver/candles/:code', async (c) => {
  const count = parseInt(c.req.query('count') || '30')
  const data = await naverGetCandles(c.req.param('code'), Math.min(count, 120))
  return c.json(data)
})

// ── 네이버 금융 프록시: 거래량 순위 (API 키 불필요)
app.get('/api/naver/volume-rank', async (c) => {
  const market = (c.req.query('market') || 'KOSPI') as 'KOSPI' | 'KOSDAQ'
  const top    = parseInt(c.req.query('top') || '20')
  const data   = await naverGetVolumeRank(market, Math.min(top, 50))
  return c.json(data)
})

// ── 기존 KIS 라우트 유지 (실전 모드 직접 호출 대비 — 서버에서 작동 시)
app.get('/api/stock/price/:ticker', async (c) => {
  // 네이버 프록시로 리다이렉트
  const data = await naverGetPrice(c.req.param('ticker'))
  return c.json(data)
})

app.get('/api/stock/candles/:ticker', async (c) => {
  const data = await naverGetCandles(c.req.param('ticker'), 30)
  return c.json(data)
})

app.get('/api/stock/volume-rank', async (c) => {
  const data = await naverGetVolumeRank('KOSPI', 20)
  return c.json(data)
})

// 잔고 조회 (레거시 경로 → /api/kis/balance 로 위임)
app.get('/api/account/balance', async (c) => {
  return c.json({ error: '/api/kis/balance POST 를 사용하세요', redirect: '/api/kis/balance' }, 301)
})

// 인메모리 폴백 스토어 (KV 없을 때)
const memStore: Record<string, any> = {}

async function kvGet(kv: KVNamespace | undefined, key: string) {
  if (kv) { try { return await kv.get(key, 'json') } catch { } }
  return memStore[key] ?? null
}

async function kvPut(kv: KVNamespace | undefined, key: string, value: any) {
  if (kv) { try { await kv.put(key, JSON.stringify(value)); return } catch { } }
  memStore[key] = value
}

// 전략 상태 저장 / 조회
app.get('/api/bot/state', async (c) => {
  const state = await kvGet(c.env.KV, 'bot_state')
  return c.json(state || getDefaultState())
})

app.post('/api/bot/state', async (c) => {
  const body = await c.req.json()
  await kvPut(c.env.KV, 'bot_state', body)
  return c.json({ ok: true })
})

// 거래 내역 조회
app.get('/api/trades', async (c) => {
  const trades = await kvGet(c.env.KV, 'trade_history')
  return c.json(trades || [])
})

app.post('/api/trades', async (c) => {
  const body = await c.req.json()
  const existing: any[] = (await kvGet(c.env.KV, 'trade_history')) || []
  existing.unshift(body)
  const trimmed = existing.slice(0, 500)
  await kvPut(c.env.KV, 'trade_history', trimmed)
  return c.json({ ok: true })
})

function getDefaultState() {
  return {
    running: false,
    mode: 'paper',
    strategy: 'scalping',
    positions: [],
    stats: {
      totalTrades: 0,
      winTrades: 0,
      totalProfit: 0,
      dailyProfit: 0,
    },
    config: {
      maxPositions: 3,
      positionSizeRatio: 0.3,
      profitTarget: 1.5,
      stopLoss: 1.0,
      scanInterval: 30,
      paperCapital: 5000000,
    },
  }
}

// ─────────────────────────────────────────────
// 텔레그램 프록시 엔드포인트
// 클라이언트에서 Bot Token을 직접 Telegram API에 노출하지 않도록 서버 경유
// ─────────────────────────────────────────────
app.post('/api/telegram/send', async (c) => {
  try {
    const { botToken, chatId, text } = await c.req.json()
    if (!botToken || !chatId || !text) {
      return c.json({ ok: false, error: 'botToken, chatId, text 필요' }, 400)
    }
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    })
    const data: any = await res.json()
    if (!data.ok) {
      return c.json({ ok: false, error: data.description || '텔레그램 전송 실패' }, 400)
    }
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '서버 오류' }, 500)
  }
})

// ─────────────────────────────────────────────
// 메인 페이지
// ─────────────────────────────────────────────
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>📈 StockBot - 주식 자동매매</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <link rel="stylesheet" href="/static/style.css?v=t1786636992">
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">

<!-- 헤더 -->
<header class="bg-gray-900 border-b border-gray-800 sticky top-0 z-50">
  <div class="max-w-screen-2xl mx-auto px-4 py-3 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <span class="text-2xl">📈</span>
      <span class="text-xl font-bold text-white">StockBot</span>
      <span class="text-xs text-gray-400 bg-gray-800 px-2 py-1 rounded">한국투자증권 KIS API</span>
    </div>
    <div class="flex items-center gap-4">
      <div id="market-status" class="flex items-center gap-2 text-sm">
        <span class="w-2 h-2 rounded-full bg-gray-500" id="market-dot"></span>
        <span id="market-label" class="text-gray-400">장 상태 확인 중...</span>
      </div>
      <button onclick="openApiSettings()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm transition flex items-center gap-2">
        <i class="fas fa-key text-xs"></i> API 설정
      </button>
    </div>
  </div>
</header>

<!-- 메인 컨텐츠 -->
<main class="max-w-screen-2xl mx-auto px-4 py-6 space-y-6">

  <!-- 통계 카드 -->
  <div class="grid grid-cols-2 md:grid-cols-4 gap-4">

    <!-- 총 자산 카드 (실시간 업데이트) -->
    <div class="stat-card bg-gray-900 rounded-xl p-4 border border-gray-800 relative overflow-hidden">
      <div class="flex items-center justify-between mb-1">
        <span class="text-gray-400 text-xs">총 자산</span>
        <span id="stat-asset-badge" class="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">페이퍼</span>
      </div>
      <div id="stat-total-asset" class="text-2xl font-bold text-white tracking-tight">-</div>
      <div class="mt-2 flex items-center justify-between text-xs">
        <span class="text-gray-500">현금</span>
        <span id="stat-cash" class="text-blue-400 font-medium">-</span>
        <button onclick="openBalanceInput()" title="원화 잔고 직접 입력" class="ml-1 text-gray-600 hover:text-yellow-400 transition" style="font-size:10px">✏️</button>
      </div>
      <!-- 잔고 직접 입력 행 (서버 차단 시 표시) -->
      <div id="manual-balance-row" class="hidden mt-1 flex items-center gap-1">
        <input id="manual-balance-input" type="number" placeholder="원화 잔고 입력" min="0" step="100000"
          class="flex-1 bg-gray-800 border border-yellow-600 rounded px-2 py-0.5 text-xs text-white w-0"
          onkeydown="if(event.key==='Enter') applyManualBalance()">
        <button onclick="applyManualBalance()" class="px-2 py-0.5 bg-yellow-600 hover:bg-yellow-500 rounded text-xs whitespace-nowrap">적용</button>
        <button onclick="closeBalanceInput()" class="px-1 py-0.5 text-gray-500 hover:text-white text-xs">✕</button>
      </div>
      <div class="mt-1 flex items-center justify-between text-xs">
        <span class="text-gray-500">주식 평가</span>
        <span id="stat-stock-value" class="text-yellow-400 font-medium">-</span>
      </div>
      <!-- 자산 변동 표시 바 -->
      <div class="mt-2 h-0.5 bg-gray-800 rounded">
        <div id="stat-asset-bar" class="h-0.5 rounded bg-blue-500 transition-all duration-500" style="width:100%"></div>
      </div>
    </div>

    <!-- 오늘 손익 카드 -->
    <div class="stat-card bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div class="text-gray-400 text-xs mb-1">오늘 손익</div>
      <div id="stat-daily-profit" class="text-2xl font-bold text-white">-</div>
      <div class="mt-2 flex items-center justify-between text-xs">
        <span class="text-gray-500">수익률</span>
        <span id="stat-daily-rate" class="text-gray-400 font-medium">-</span>
      </div>
      <div class="mt-1 flex items-center justify-between text-xs">
        <span class="text-gray-500">미실현 손익</span>
        <span id="stat-unrealized" class="text-gray-400 font-medium">-</span>
      </div>
    </div>

    <!-- 누적 손익 카드 -->
    <div class="stat-card bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div class="text-gray-400 text-xs mb-1">누적 손익</div>
      <div id="stat-total-profit" class="text-2xl font-bold text-white">-</div>
      <div class="mt-2 flex items-center justify-between text-xs">
        <span class="text-gray-500">승률</span>
        <span id="stat-win-rate" class="text-gray-400 font-medium">-</span>
      </div>
      <div class="mt-1 flex items-center justify-between text-xs">
        <span class="text-gray-500">총 거래</span>
        <span id="stat-trades" class="text-gray-400 font-medium">0회</span>
      </div>
    </div>

    <!-- 포지션 카드 -->
    <div class="stat-card bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div class="flex items-center justify-between mb-1">
        <span class="text-gray-400 text-xs">포지션</span>
        <!-- 최대 포지션 수 직접 입력 -->
        <div class="flex items-center gap-1">
          <span class="text-xs text-gray-500">최대</span>
          <button onclick="changeMaxPos(-1)" class="w-5 h-5 rounded bg-gray-700 hover:bg-gray-600 text-xs flex items-center justify-center leading-none">−</button>
          <span id="maxpos-display" class="text-xs text-blue-400 font-bold w-4 text-center">3</span>
          <button onclick="changeMaxPos(+1)" class="w-5 h-5 rounded bg-gray-700 hover:bg-gray-600 text-xs flex items-center justify-center leading-none">+</button>
        </div>
      </div>
      <!-- 포지션 슬롯 시각화 -->
      <div id="pos-slots" class="flex gap-1 flex-wrap mb-2">
      </div>
      <div id="stat-positions" class="text-2xl font-bold text-white">0 / 3</div>
      <div class="mt-1 flex items-center justify-between text-xs">
        <span class="text-gray-500">가용 슬롯</span>
        <span id="stat-slots-left" class="text-green-400 font-medium">3개 여유</span>
      </div>
    </div>

  </div>

  <!-- 봇 컨트롤 + 전략 설정 -->
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">

    <!-- 봇 컨트롤 -->
    <div class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-4">
      <h2 class="text-sm font-semibold text-gray-300 flex items-center gap-2">
        <i class="fas fa-robot text-blue-400"></i> 봇 컨트롤
      </h2>

      <!-- 모드 선택 -->
      <div>
        <label class="text-xs text-gray-400 mb-2 block">실행 모드</label>
        <div class="grid grid-cols-2 gap-2">
          <button id="mode-paper" onclick="setMode('paper')"
            class="mode-btn active-mode py-2 rounded text-sm font-medium transition">
            📄 페이퍼
          </button>
          <button id="mode-live" onclick="setMode('live')"
            class="mode-btn py-2 rounded text-sm font-medium transition">
            🔴 실전
          </button>
        </div>
      </div>

      <!-- 시장 선택 -->
      <div>
        <label class="text-xs text-gray-400 mb-2 block">시장 선택</label>
        <div class="grid grid-cols-3 gap-1.5">
          <button id="market-KR" onclick="setMarket('KR')"
            class="market-btn active-market py-1.5 rounded text-xs font-medium transition">
            🇰🇷 국내
          </button>
          <button id="market-BOTH" onclick="setMarket('BOTH')"
            class="market-btn py-1.5 rounded text-xs font-medium transition">
            🌏 국내+미국
          </button>
          <button id="market-US" onclick="setMarket('US')"
            class="market-btn py-1.5 rounded text-xs font-medium transition">
            🇺🇸 미국
          </button>
        </div>
        <!-- 코스피/코스닥 선택 패널 (KR 모드일 때만 표시) -->
        <div id="kr-exchange-panel" class="mt-2">
          <label class="text-xs text-gray-500 mb-1.5 block">거래소 선택</label>
          <div class="grid grid-cols-3 gap-1">
            <button id="krex-KOSPI" onclick="setKrExchange('KOSPI')"
              class="market-btn py-1.5 rounded text-xs font-medium transition">
              🔵 코스피
            </button>
            <button id="krex-BOTH" onclick="setKrExchange('BOTH')"
              class="market-btn active-market py-1.5 rounded text-xs font-medium transition">
              📊 둘다
            </button>
            <button id="krex-KOSDAQ" onclick="setKrExchange('KOSDAQ')"
              class="market-btn py-1.5 rounded text-xs font-medium transition">
              🟣 코스닥
            </button>
          </div>
        </div>
        <!-- 환율 패널 (미국/BOTH 모드일 때만 표시) -->
        <div id="fx-panel" class="hidden mt-2 flex items-center justify-between bg-gray-800/60 rounded px-2.5 py-1.5">
          <span class="text-xs text-gray-400">💱 환율</span>
          <span id="fx-rate-display" class="text-xs text-yellow-400 font-medium">$1 = 1,380원</span>
        </div>
      </div>

      <!-- 전략 선택 -->
      <div>
        <label class="text-xs text-gray-400 mb-2 block">매매 전략</label>
        <select id="strategy-select" class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm">
          <option value="scalping">⚡ 스캘핑 (단기 변동성)</option>
          <option value="volume">📊 거래량 급증 포착</option>
          <option value="momentum">🚀 모멘텀 추종</option>
          <option value="mean_reversion">↩️ 평균 회귀</option>
        </select>
      </div>

      <!-- 시작/정지 버튼 -->
      <button id="bot-toggle-btn" onclick="toggleBot()"
        class="w-full py-3 rounded-lg text-base font-bold transition bg-green-600 hover:bg-green-700">
        <i class="fas fa-play mr-2"></i> 봇 시작
      </button>

      <!-- 봇 상태 -->
      <div id="bot-status-area" class="text-xs text-gray-500 space-y-1 pt-2 border-t border-gray-800">
        <div class="flex justify-between"><span>상태</span><span id="bot-running-label" class="text-gray-400">정지</span></div>
        <div class="flex justify-between"><span>스캔 주기</span><span id="bot-interval-label" class="text-blue-400">30초</span></div>
        <div class="flex justify-between"><span>다음 스캔</span><span id="next-scan-label" class="text-gray-400">-</span></div>
        <!-- 적응형 모드 상태 -->
        <div class="flex justify-between items-center pt-1 border-t border-gray-800/50">
          <span>진입 모드</span>
          <span id="adaptive-badge" class="text-xs px-2 py-0.5 rounded border font-medium bg-blue-900/60 text-blue-300 border-blue-700">🔵 기본</span>
        </div>
        <div class="flex justify-between">
          <span>적응 기준</span>
          <span id="adaptive-winrate" class="text-gray-500">거래 없음</span>
        </div>
      </div>
    </div>

    <!-- 전략 파라미터 -->
    <div class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-4">
      <h2 class="text-sm font-semibold text-gray-300 flex items-center gap-2">
        <i class="fas fa-sliders-h text-purple-400"></i> 전략 파라미터
      </h2>

      <div class="space-y-3">
        <!-- 익절 목표 -->
        <div>
          <label class="text-xs text-gray-400 flex justify-between mb-1">
            <span>익절 목표 (%)</span><span id="profit-val" class="text-green-400">1.5%</span>
          </label>
          <div class="flex items-center gap-2">
            <input type="range" id="profit-target" min="0.5" max="5" step="0.1" value="1.5"
              oninput="updateSlider('profit-target','profit-val','%'); renderStrategyConditions()"
              class="flex-1 accent-green-500">
            <input type="number" id="profit-target-num" min="0.5" max="5" step="0.1" value="1.5"
              oninput="syncSliderFromNum('profit-target','profit-target-num','profit-val','%'); renderStrategyConditions()"
              class="w-14 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-green-400 text-center focus:outline-none focus:border-green-500">
          </div>
        </div>
        <!-- 손절 기준 -->
        <div>
          <label class="text-xs text-gray-400 flex justify-between mb-1">
            <span>손절 기준 (%)</span><span id="stoploss-val" class="text-red-400">1.0%</span>
          </label>
          <div class="flex items-center gap-2">
            <input type="range" id="stop-loss" min="0.3" max="3" step="0.1" value="1.0"
              oninput="updateSlider('stop-loss','stoploss-val','%'); renderStrategyConditions()"
              class="flex-1 accent-red-500">
            <input type="number" id="stop-loss-num" min="0.3" max="3" step="0.1" value="1.0"
              oninput="syncSliderFromNum('stop-loss','stop-loss-num','stoploss-val','%'); renderStrategyConditions()"
              class="w-14 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-red-400 text-center focus:outline-none focus:border-red-500">
          </div>
        </div>
        <!-- 최대 포지션 수 (슬라이더 + 숫자 직접 입력) -->
        <div>
          <label class="text-xs text-gray-400 flex justify-between mb-1">
            <span>최대 포지션 수</span><span id="maxpos-val" class="text-blue-400">3개</span>
          </label>
          <div class="flex items-center gap-2">
            <input type="range" id="max-positions" min="1" max="20" step="1" value="3"
              oninput="updateSlider('max-positions','maxpos-val','개'); syncMaxPosCard()"
              class="flex-1 accent-blue-500">
            <input type="number" id="max-positions-num" min="1" max="20" step="1" value="3"
              oninput="syncSliderFromNum('max-positions','max-positions-num','maxpos-val','개'); syncMaxPosCard()"
              class="w-14 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-blue-400 text-center focus:outline-none focus:border-blue-500">
          </div>
        </div>
        <!-- 포지션 금액 범위 -->
        <div class="bg-gray-800/60 rounded-lg p-3 space-y-2.5 border border-gray-700/50">
          <div class="flex items-center justify-between">
            <span class="text-xs text-gray-300 font-medium">포지션 1건 금액 범위</span>
            <button onclick="resetPositionRange()" class="text-xs text-gray-500 hover:text-blue-400 transition">
              <i class="fas fa-undo-alt mr-0.5"></i>기본값
            </button>
          </div>
          <!-- 자동 기본값 미리보기 -->
          <div id="pos-range-preview" class="text-xs text-blue-300/80 bg-blue-950/40 rounded px-2 py-1.5 border border-blue-900/40">
            자본금 기준 자동 계산됩니다
          </div>
          <!-- 최솟값 -->
          <div>
            <label class="text-xs text-gray-400 flex justify-between mb-1">
              <span>최소 투자금</span>
              <span id="pos-min-val" class="text-yellow-400 font-medium">50,000원</span>
            </label>
            <div class="flex items-center gap-2">
              <input type="range" id="pos-min" min="10000" max="5000000" step="10000" value="50000"
                oninput="onPosRangeChange()"
                class="flex-1 accent-yellow-500">
              <input type="number" id="pos-min-num" min="1" max="9999" step="1" value="5"
                oninput="onPosRangeNumChange('min')"
                class="w-14 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-yellow-400 text-center focus:outline-none focus:border-yellow-500">
              <span class="text-xs text-gray-500 w-5">만</span>
            </div>
          </div>
          <!-- 최댓값 -->
          <div>
            <label class="text-xs text-gray-400 flex justify-between mb-1">
              <span>최대 투자금</span>
              <span id="pos-max-val" class="text-orange-400 font-medium">150,000원</span>
            </label>
            <div class="flex items-center gap-2">
              <input type="range" id="pos-max" min="10000" max="5000000" step="10000" value="150000"
                oninput="onPosRangeChange()"
                class="flex-1 accent-orange-500">
              <input type="number" id="pos-max-num" min="1" max="9999" step="1" value="15"
                oninput="onPosRangeNumChange('max')"
                class="w-14 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-orange-400 text-center focus:outline-none focus:border-orange-500">
              <span class="text-xs text-gray-500 w-5">만</span>
            </div>
          </div>
          <!-- 상한율 슬라이더 (기본 최댓값 대비 배수) -->
          <div class="pt-1 border-t border-gray-700/50">
            <label class="text-xs text-gray-400 flex justify-between mb-1">
              <span>상한율 <span class="text-gray-600">(기본 최대 대비)</span></span>
              <span id="pos-cap-val" class="text-red-400 font-medium">1.0×</span>
            </label>
            <input type="range" id="pos-cap" min="1.0" max="5.0" step="0.5" value="1.0"
              oninput="onPosCapChange()"
              class="w-full accent-red-500">
            <div class="flex justify-between text-xs text-gray-600 mt-0.5">
              <span>기본</span><span>1.5×</span><span>2×</span><span>3×</span><span>4×</span><span>5×</span>
            </div>
          </div>
          <!-- 최종 적용 범위 요약 -->
          <div class="flex items-center justify-between bg-gray-900/60 rounded px-2 py-1.5 text-xs">
            <span class="text-gray-500">실제 적용 범위</span>
            <span id="pos-range-final" class="text-white font-medium">5만 ~ 15만원</span>
          </div>
        </div>
        <!-- 페이퍼 초기 자금 -->
        <div>
          <label class="text-xs text-gray-400 flex justify-between mb-1">
            <span>페이퍼 초기 자금</span><span id="paper-capital-val" class="text-gray-300">500만원</span>
          </label>
          <div class="flex items-center gap-2">
            <input type="range" id="paper-capital" min="1" max="50" step="1" value="5"
              oninput="updateCapitalSlider()"
              class="flex-1 accent-gray-400">
            <input type="number" id="paper-capital-num" min="1" max="50" step="1" value="5"
              oninput="syncCapitalFromNum()"
              class="w-14 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-gray-300 text-center focus:outline-none focus:border-gray-500">
            <span class="text-xs text-gray-500">00만</span>
          </div>
        </div>
      </div>

      <button onclick="saveConfig()" class="w-full py-2 bg-purple-700 hover:bg-purple-600 rounded text-sm transition">
        <i class="fas fa-save mr-1"></i> 설정 저장
      </button>
    </div>

    <!-- 전략 진입 조건 표시 -->
    <div class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-3">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <i class="fas fa-filter text-yellow-400"></i> 현재 진입 조건
        </h2>
        <span id="adaptive-badge-2" class="text-xs px-2 py-0.5 rounded border font-medium bg-blue-900/60 text-blue-300 border-blue-700">🔵 기본</span>
      </div>
      <div id="strategy-conditions" class="space-y-2 text-xs">
        <!-- 동적 렌더링 -->
      </div>
      <div class="pt-3 border-t border-gray-800">
        <div class="text-xs text-gray-500 mb-2">청산 조건</div>
        <div id="exit-conditions" class="space-y-1 text-xs"></div>
      </div>
      <div class="pt-2 border-t border-gray-800 text-xs text-gray-500">
        <div class="flex justify-between"><span>수수료 (매수+매도)</span><span class="text-gray-300">0.015% + 0.23%</span></div>
        <div class="flex justify-between mt-1"><span>실제 수익 계산</span><span class="text-gray-300">목표 - 0.245%</span></div>
      </div>
    </div>
  </div>

  <!-- 포지션 + 로그 -->
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

    <!-- 보유 포지션 -->
    <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <i class="fas fa-briefcase text-green-400"></i> 보유 포지션
        </h2>
        <button onclick="refreshPositions()" class="text-xs text-gray-500 hover:text-gray-300 transition">
          <i class="fas fa-sync-alt"></i>
        </button>
      </div>
      <div id="positions-list" class="space-y-2 min-h-[120px]">
        <div class="text-gray-600 text-sm text-center py-8">포지션 없음</div>
      </div>
    </div>

    <!-- 실시간 로그 -->
    <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <i class="fas fa-terminal text-cyan-400"></i> 실시간 로그
        </h2>
        <button onclick="clearLog()" class="text-xs text-gray-500 hover:text-gray-300 transition">
          <i class="fas fa-trash"></i> 지우기
        </button>
      </div>
      <div id="log-area" class="bg-gray-950 rounded p-3 h-52 overflow-y-auto font-mono text-xs space-y-0.5"></div>
    </div>
  </div>

  <!-- 차트 + 거래내역 -->
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

    <!-- 수익 차트 -->
    <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <i class="fas fa-chart-line text-blue-400"></i> 누적 손익 추이
        </h2>
      </div>
      <canvas id="profit-chart" height="180"></canvas>
    </div>

    <!-- 거래 내역 -->
    <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <i class="fas fa-history text-orange-400"></i> 최근 거래 내역
        </h2>
        <button onclick="clearTrades()" class="text-xs text-gray-500 hover:text-gray-300">지우기</button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="text-gray-500 border-b border-gray-800">
              <th class="pb-2 text-left">종목</th>
              <th class="pb-2 text-right">매수가</th>
              <th class="pb-2 text-right">매도가</th>
              <th class="pb-2 text-right">수익률</th>
              <th class="pb-2 text-right">결과</th>
            </tr>
          </thead>
          <tbody id="trades-tbody" class="divide-y divide-gray-800/50">
            <tr><td colspan="5" class="text-center text-gray-600 py-6">거래 내역 없음</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- 종목 스캐너 -->
  <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-sm font-semibold text-gray-300 flex items-center gap-2">
        <i class="fas fa-search text-pink-400"></i> 종목 스캐너
      </h2>
      <div class="flex gap-2">
        <input id="ticker-input" type="text" placeholder="종목코드 (예: 005930)" maxlength="6"
          class="bg-gray-800 border border-gray-700 rounded px-3 py-1 text-sm w-40 focus:outline-none focus:border-blue-500">
        <button onclick="lookupStock()" class="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-sm transition">조회</button>
        <button onclick="loadVolumeRank()" class="px-3 py-1 bg-pink-700 hover:bg-pink-600 rounded text-sm transition">거래량 상위</button>
      </div>
    </div>
    <div id="scanner-result" class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 min-h-[60px]">
      <div class="col-span-full text-gray-600 text-sm text-center py-4">종목을 검색하거나 거래량 상위를 불러오세요</div>
    </div>
  </div>

</main>

<!-- API 설정 모달 -->
<div id="api-modal" class="hidden fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
  <div class="bg-gray-900 rounded-2xl p-6 w-full max-w-md border border-gray-700 space-y-4 overflow-y-auto max-h-[90vh]">
    <div class="flex items-center justify-between">
      <h3 class="text-base font-bold flex items-center gap-2"><i class="fas fa-key text-yellow-400"></i> KIS API 설정</h3>
      <button onclick="closeApiSettings()" class="text-gray-500 hover:text-white"><i class="fas fa-times"></i></button>
    </div>

    <div class="bg-blue-950/50 border border-blue-800 rounded p-3 text-xs text-blue-300 space-y-1">
      <p><i class="fas fa-info-circle mr-1"></i> <strong>한국투자증권 KIS Developers</strong> API 키를 입력하세요.</p>
      <p>• <a href="https://apiportal.koreainvestment.com" target="_blank" class="underline">apiportal.koreainvestment.com</a> 에서 발급</p>
      <p>• 페이퍼 모드는 실전계좌 APP KEY로 모의투자 가능</p>
    </div>

    <div class="space-y-3">
      <div>
        <label class="text-xs text-gray-400 mb-1 block">APP KEY</label>
        <input id="input-app-key" type="password" placeholder="KIS APP KEY"
          class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
      </div>
      <div>
        <label class="text-xs text-gray-400 mb-1 block">APP SECRET</label>
        <input id="input-app-secret" type="password" placeholder="KIS APP SECRET"
          class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
      </div>
      <div>
        <label class="text-xs text-gray-400 mb-1 block">계좌번호 (실전 모드)</label>
        <input id="input-account-no" type="text" placeholder="예: 50012345-01"
          class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
      </div>
      <div class="border-t border-gray-700 pt-3">
        <label class="text-xs text-gray-300 mb-1 block font-semibold">
          <i class="fas fa-won-sign text-yellow-400 mr-1"></i> 통합증거금 원화 가용잔고 (수동 입력)
        </label>
        <div class="flex gap-2 items-center">
          <input id="input-krw-balance" type="number" placeholder="예: 10000000 (1000만원)"
            class="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-yellow-500"
            min="0" step="100000">
          <button onclick="applyManualKrwBalance()" class="px-3 py-2 bg-yellow-600 hover:bg-yellow-500 rounded text-sm whitespace-nowrap transition">
            적용
          </button>
        </div>
        <p class="text-xs text-gray-500 mt-1">달러 잔고($0)여도 원화로 미국주식 매수가 가능한 통합증거금 계좌입니다.<br>KIS HTS에서 확인한 <strong class="text-gray-400">해외주식 가능금액(원화)</strong>을 입력하세요.</p>
        <div id="krw-balance-display" class="text-xs text-yellow-400 mt-1 hidden"></div>
      </div>
    </div>

    <div class="flex gap-2">
      <button onclick="testApiConnection()" class="flex-1 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm transition">
        <i class="fas fa-plug mr-1"></i> 연결 테스트
      </button>
      <button onclick="saveApiKeys()" class="flex-1 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm transition">
        <i class="fas fa-save mr-1"></i> 저장
      </button>
    </div>
    <div id="api-test-result" class="text-xs text-center text-gray-500"></div>

    <!-- ── 텔레그램 알림 설정 (팝업 내부) ── -->
    <div class="border-t border-gray-700 pt-4 mt-2">
      <h4 class="text-sm font-semibold text-gray-300 mb-2">
        <i class="fab fa-telegram text-blue-400 mr-2"></i>텔레그램 알림 설정
      </h4>
      <p class="text-xs text-gray-500 mb-3">장 마감 시 거래내역·손익 리포트 자동 전송<br>
        Chat ID 모를 땐 텔레그램에서 <span class="text-blue-400 font-bold">@myidbot</span> 검색 → <span class="text-blue-400">/getid</span> 전송
      </p>
      <div class="space-y-2">
        <div>
          <label class="text-xs text-gray-400 mb-1 block">Bot Token</label>
          <input id="tg-bot-token" type="password" placeholder="예: 1234567890:ABCDEFGabcdefg..."
            class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
        </div>
        <div>
          <label class="text-xs text-gray-400 mb-1 block">Chat ID</label>
          <input id="tg-chat-id" type="text" placeholder="예: 123456789"
            class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
        </div>
      </div>
      <div class="flex gap-2 mt-3">
        <button onclick="testTelegram()" class="flex-1 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm transition">
          <i class="fas fa-paper-plane mr-1"></i> 테스트 전송
        </button>
        <button onclick="saveTelegramKeys()" class="flex-1 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm transition">
          <i class="fas fa-save mr-1"></i> 저장
        </button>
      </div>
      <div id="tg-test-result" class="text-xs text-center mt-2" style="display:none"></div>
    </div>
  </div>
</div>

<script src="/static/app.js"></script>
</body>
</html>`)
})

// Cloudflare Pages: ASSETS 바인딩으로 정적 파일 서빙 (API가 아닌 모든 요청에 폴백)
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    // API + favicon 등 Worker 라우트는 Hono가 처리
    const url = new URL(request.url)
    const isApiOrWorkerRoute = (
      url.pathname.startsWith('/api/') ||
      url.pathname === '/favicon.svg' ||
      url.pathname === '/favicon.ico' ||
      url.pathname === '/' ||
      url.pathname === ''
    )

    if (isApiOrWorkerRoute) {
      return app.fetch(request, env, ctx)
    }

    // /static/*, 기타 경로 → ASSETS 바인딩으로 정적 파일 서빙
    if (env.ASSETS) {
      return env.ASSETS.fetch(request)
    }

    // ASSETS 없으면 Hono 라우터에서 처리
    return app.fetch(request, env, ctx)
  }
}
