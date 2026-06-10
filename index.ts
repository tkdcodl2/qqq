// ============================================================
//  Supabase Edge Function: fetch-market-data  (v3)
//  네이버 증권 API를 1차 소스로 QQQ/QLD/TQQQ 종가 + USD/KRW 환율을 받아
//  market_data 테이블에 upsert (fx 컬럼 포함). 매일 cron 으로 호출하세요.
//
//  소스 우선순위 (모두 키 불필요):
//    · 시세:  네이버 해외주식 → (실패 시) 야후 파이낸스
//    · 환율:  네이버 환율(FX_USDKRW) → (실패 시) open.er-api.com
//  ※ 브라우저(클라이언트)는 CORS 때문에 네이버를 직접 못 부르므로,
//    서버(Edge Function)에서 받아 DB에 저장하고 앱은 DB의 fx 를 읽습니다.
//  실패 시 응답의 "diag" 에 소스별 사유가 남습니다.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UA = "Mozilla/5.0 (compatible; RegimeDashboard/1.0)";
const NAVER_HEADERS = { "User-Agent": UA, "Accept": "application/json", "Referer": "https://m.stock.naver.com/" };

const TICKERS = ["QQQ", "QLD", "TQQQ", "SCHD"] as const;
type Ticker = (typeof TICKERS)[number];
// 네이버 해외종목 로이터코드 (.O=나스닥, .K=NYSE Arca)
const NAVER_CODE: Record<Ticker, string> = { QQQ: "QQQ.O", QLD: "QLD.K", TQQQ: "TQQQ.O", SCHD: "SCHD.K" };
type Bars = Record<string, number>; // "YYYY-MM-DD" -> close

const diag: Record<string, string> = {};
const r2 = (n: number) => Math.round(n * 100) / 100;
const toNum = (v: unknown) => typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
function normDate(v: unknown): string | null {
  let s = String(v ?? "").trim();
  if (!s) return null;
  s = s.replace(/[.\/]/g, "-");
  const digits = s.replace(/[^0-9]/g, "");
  if (digits.length >= 8 && !s.includes("-")) return `${digits.slice(0,4)}-${digits.slice(4,6)}-${digits.slice(6,8)}`;
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
// JSON 모양이 달라도 closePrice+날짜를 가진 배열을 찾아 Bars 로 변환
function extractBars(json: any): Bars {
  let arr: any[] | null = Array.isArray(json) ? json
    : json?.result ?? json?.priceInfos ?? json?.prices ?? json?.datas ?? null;
  if (!arr) for (const v of Object.values(json ?? {})) if (Array.isArray(v) && v.length && typeof v[0] === "object") { arr = v as any[]; break; }
  const out: Bars = {};
  for (const it of arr ?? []) {
    const close = toNum(it.closePrice ?? it.closeprice ?? it.tradePrice ?? it.close);
    const d = normDate(it.localTradedAt ?? it.localDate ?? it.bizdate ?? it.date ?? it.dt);
    if (d && !isNaN(close)) out[d] = r2(close);
  }
  return out;
}

// ---------- 네이버 ----------
async function naverStock(t: Ticker): Promise<Bars | null> {
  const code = NAVER_CODE[t];
  for (const url of [
    `https://api.stock.naver.com/stock/${code}/price?pageSize=15&page=1`,
    `https://api.stock.naver.com/stock/${code}/basic`,
  ]) {
    try {
      const res = await fetch(url, { headers: NAVER_HEADERS });
      if (!res.ok) { diag[`naver:${t}`] = `HTTP ${res.status}`; continue; }
      const j = await res.json();
      let bars = extractBars(j);
      if (!Object.keys(bars).length && j?.closePrice != null) { // basic 단일객체
        const d = normDate(j.localTradedAt ?? j.tradeStopDate ?? new Date().toISOString());
        const c = toNum(j.closePrice);
        if (d && !isNaN(c)) bars = { [d]: r2(c) };
      }
      if (Object.keys(bars).length) return bars;
    } catch (e) { diag[`naver:${t}`] = String(e); }
  }
  return null;
}
async function naverFx(): Promise<Bars | null> {
  for (const url of [
    `https://api.stock.naver.com/marketindex/exchange/FX_USDKRW/prices?page=1&pageSize=15`,
    `https://m.stock.naver.com/front-api/v1/marketIndex/prices?category=exchange&reutersCode=FX_USDKRW&page=1&pageSize=15`,
  ]) {
    try {
      const res = await fetch(url, { headers: NAVER_HEADERS });
      if (!res.ok) { diag["naver:fx"] = `HTTP ${res.status}`; continue; }
      const bars = extractBars(await res.json());
      if (Object.keys(bars).length) return bars;
    } catch (e) { diag["naver:fx"] = String(e); }
  }
  return null;
}

// ---------- 폴백 ----------
async function yahoo(t: Ticker): Promise<Bars | null> {
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${t}?interval=1d&range=1mo`, { headers: { "User-Agent": UA } });
      if (!res.ok) { diag[`yahoo:${t}`] = `HTTP ${res.status}`; continue; }
      const r = (await res.json())?.chart?.result?.[0];
      const ts: number[] = r?.timestamp ?? [], cl = r?.indicators?.quote?.[0]?.close ?? [];
      const out: Bars = {};
      for (let i = 0; i < ts.length; i++) if (cl[i] != null) out[new Date(ts[i]*1000).toISOString().slice(0,10)] = r2(cl[i]);
      if (Object.keys(out).length) return out;
    } catch (e) { diag[`yahoo:${t}`] = String(e); }
  }
  return null;
}
async function erApiFx(): Promise<number | null> {
  try {
    const j = await (await fetch("https://open.er-api.com/v6/latest/USD")).json();
    const k = j?.rates?.KRW; return k ? r2(k) : null;
  } catch (e) { diag["erapi:fx"] = String(e); return null; }
}

async function priceSeries(t: Ticker): Promise<Bars> { return (await naverStock(t)) ?? (await yahoo(t)) ?? {}; }

Deno.serve(async () => {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const out: Record<string, unknown> = {};

  const maps = {} as Record<Ticker, Bars>;
  for (const t of TICKERS) { maps[t] = await priceSeries(t); out[`${t}_days`] = Object.keys(maps[t]).length; }

  // 환율: 네이버 → er-api
  let fxMap = await naverFx() ?? {};
  let latestFx = 0;
  const fxDates = Object.keys(fxMap).sort();
  if (fxDates.length) latestFx = fxMap[fxDates[fxDates.length - 1]];
  if (!latestFx) { const r = await erApiFx(); if (r) latestFx = r; }
  out["fx_latest"] = latestFx || null;

  const common = Object.keys(maps.QQQ).filter((d) => maps.QLD[d] != null && maps.TQQQ[d] != null).sort();
  if (!common.length) { out["note"] = "완전한 행(3종목 동일일자) 없음 — upsert 생략"; out["diag"] = diag; return json(out); }

  const rows = common.slice(-10).map((d) => ({
    date: d, qqq: maps.QQQ[d], qld: maps.QLD[d], tqqq: maps.TQQQ[d],
    schd: maps.SCHD?.[d] ?? null,
    fx: fxMap[d] ?? latestFx ?? null,
  }));
  const { error } = await sb.from("market_data").upsert(rows, { onConflict: "date" });
  if (error) out["upsert_error"] = error.message;
  else { out["upserted_dates"] = rows.map((r) => r.date); out["latest"] = rows[rows.length - 1]; }
  if (Object.keys(diag).length) out["diag"] = diag;
  return json(out);
});

function json(o: unknown) { return new Response(JSON.stringify(o, null, 2), { headers: { "content-type": "application/json" } }); }
