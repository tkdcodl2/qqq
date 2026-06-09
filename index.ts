// ============================================================
//  Supabase Edge Function: fetch-market-data
//  QQQ / QLD / TQQQ 최신 종가를 받아 market_data 테이블에 upsert.
//  매일 1회 cron 으로 호출하세요 (배포 안내는 README 참고).
//
//  데이터 소스: Stooq(키 불필요)를 기본으로, 실패 시 Alpha Vantage(키 필요) 폴백.
//  Alpha Vantage 키가 있으면 환경변수 ALPHAVANTAGE_KEY 로 주입하세요.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!; // 서버 전용 키
const AV_KEY = Deno.env.get("ALPHAVANTAGE_KEY") ?? "";

const TICKERS = ["QQQ", "QLD", "TQQQ"] as const;
type Ticker = (typeof TICKERS)[number];

// --- Stooq: 일별 CSV (미국 종목은 .us 접미사) ---
async function fromStooq(t: Ticker): Promise<{ date: string; close: number } | null> {
  try {
    const url = `https://stooq.com/q/d/l/?s=${t.toLowerCase()}.us&i=d`;
    const csv = await (await fetch(url)).text();
    const lines = csv.trim().split("\n");
    if (lines.length < 2) return null;
    const last = lines[lines.length - 1].split(","); // Date,Open,High,Low,Close,Volume
    const date = last[0];
    const close = parseFloat(last[4]);
    if (!date || isNaN(close)) return null;
    return { date, close };
  } catch {
    return null;
  }
}

// --- Alpha Vantage 폴백 ---
async function fromAlphaVantage(t: Ticker): Promise<{ date: string; close: number } | null> {
  if (!AV_KEY) return null;
  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${t}&apikey=${AV_KEY}`;
    const j = await (await fetch(url)).json();
    const series = j["Time Series (Daily)"];
    if (!series) return null;
    const date = Object.keys(series).sort().pop()!;
    const close = parseFloat(series[date]["4. close"]);
    if (!date || isNaN(close)) return null;
    return { date, close };
  } catch {
    return null;
  }
}

async function latest(t: Ticker) {
  return (await fromStooq(t)) ?? (await fromAlphaVantage(t));
}

Deno.serve(async () => {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const results: Record<string, unknown> = {};

  const fetched = await Promise.all(
    TICKERS.map(async (t) => ({ t, r: await latest(t) })),
  );

  // 세 종목 모두 같은 거래일이어야 한 행으로 upsert
  const byDate: Record<string, Partial<Record<Ticker, number>>> = {};
  for (const { t, r } of fetched) {
    if (!r) { results[t] = "fetch_failed"; continue; }
    (byDate[r.date] ??= {})[t] = r.close;
    results[t] = r;
  }

  const rows = Object.entries(byDate)
    .filter(([, v]) => v.QQQ && v.QLD && v.TQQQ)
    .map(([date, v]) => ({ date, qqq: v.QQQ, qld: v.QLD, tqqq: v.TQQQ }));

  if (rows.length) {
    const { error } = await sb.from("market_data").upsert(rows, { onConflict: "date" });
    if (error) results["upsert_error"] = error.message;
    else results["upserted"] = rows;
  } else {
    results["note"] = "완전한 행(3종목 동일일자) 없음 — upsert 생략";
  }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { "content-type": "application/json" },
  });
});
