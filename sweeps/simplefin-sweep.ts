// accountant-simplefin-sweep — the only writer of accountant_transactions.
//
// Deployed as a Supabase edge function on project your-project-ref. No
// Claude routine touches the accountant tables; this function loads them, the
// `accountant` skill curates them on demand, and the page reads them.
//
// Modes
//   dry_run  — fetch a short window, map it, write nothing. Only the reply
//              says what it saw, so a test never looks like a sync.
//   sweep    — the pg_cron job, every four hours. Window derived from the oldest per-account
//              watermark minus 5 days, clamped to [14, 44] days. One request.
//
// There was a third mode, `backfill`, which walked 90-day windows backwards
// from a cursor in accountant_backfill_state. It finished, the table was
// dropped on 2026-09-15, and the mode went with it. Anything older than the
// feed reaches now comes from a bank CSV through accountant_ingest.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const PACIFIC = "America/Los_Angeles";
const DAY = 86400;
// SimpleFIN warns on any request over 45 days, counted to now, and each
// warning fails the run and raises a Bank alert. The start is also clamped
// against now (below), because the window is anchored to the top of today's
// Pacific date and after 5pm Pacific that alone pushed 44 days past 45.
const MAX_WINDOW_DAYS = 44;
const SWEEP_LOOKBACK_PAD = 5; // re-pull this many days behind the watermark
const SWEEP_MIN_DAYS = 14;
// Pending charges are not stored (2026-10-06). The bank rewrites or drops them,
// so a rename, category or tracker link made on one was lost; a charge is
// saved once it posts, a day or two later, and is final from then on.

const pacificDate = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString("en-CA", { timeZone: PACIFIC });
const toUnix = (iso: string) => Math.floor(Date.parse(iso + "T00:00:00Z") / 1000);
const toISO = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const todayPacific = () => new Date().toLocaleDateString("en-CA", { timeZone: PACIFIC });

function splitAccessUrl(raw: string) {
  const u = new URL(raw.trim());
  const auth = btoa(decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password));
  u.username = ""; u.password = "";
  return { base: u.toString().replace(/\/$/, ""), auth };
}

type Window = { start: number; end: number | null };

async function fetchWindow(base: string, auth: string, w: Window) {
  const qs = new URLSearchParams({ "start-date": String(w.start) });
  if (w.end !== null) qs.set("end-date", String(w.end));
  const res = await fetch(base + "/accounts?" + qs.toString(), {
    headers: { Authorization: "Basic " + auth },
  });
  if (!res.ok) {
    throw new Error("SimpleFIN " + res.status + ": " + (await res.text()).slice(0, 300));
  }
  return await res.json();
}

// v1 sends `errors` + account.org; v2 sends `errlist` + connections. Handle both.
function feedErrorsOf(payload: any): string[] {
  return [
    ...(Array.isArray(payload?.errors) ? payload.errors.map(String) : []),
    ...(Array.isArray(payload?.errlist)
      ? payload.errlist.map((e: any) =>
          typeof e === "string" ? e : String(e.code) + ": " + String(e.msg))
      : []),
  ];
}

function mapRows(payload: any, byExternal: Map<string, any>) {
  const connById = new Map<string, string>(
    (payload?.connections ?? []).map((c: any) => [String(c.conn_id), c.name ?? c.org_name ?? ""]));
  const accounts: any[] = Array.isArray(payload?.accounts) ? payload.accounts : [];
  const orgOf = (a: any) =>
    a?.org?.name ?? a?.org?.domain ?? connById.get(String(a?.conn_id)) ?? null;

  const rows: any[] = [];
  const balances: any[] = [];
  const unmapped: string[] = [];
  let txnsSeen = 0;

  for (const a of accounts) {
    const txns = Array.isArray(a.transactions) ? a.transactions : [];
    txnsSeen += txns.length;
    const acct = byExternal.get(String(a.id));
    if (!acct) {
      unmapped.push((orgOf(a) ?? "?") + " / " + (a?.name ?? "?") + " [" + a.id + "]");
      continue;
    }
    // The balance comes with every fetch, whatever the window, so the
    // Wallet page's net worth is never more than one sweep old.
    const bal = Number(a.balance);
    if (a.balance != null && isFinite(bal)) {
      const when = Number(a["balance-date"]) || Math.floor(Date.now() / 1000);
      const avail = Number(a["available-balance"]);
      balances.push({ id: acct.id, balance: bal, as_of: new Date(when * 1000).toISOString(),
        day: pacificDate(when), available: a["available-balance"] != null && isFinite(avail) ? avail : null });
    }
    for (const t of txns) {
      const amt = Number(t.amount);
      if (!isFinite(amt) || amt === 0) continue;
      // `posted` is 0 until a charge settles, so a charge without it is still pending.
      const when = Number(t.posted) || 0;
      if (t.pending || !when) continue;
      rows.push({
        account_id: acct.id,
        date: pacificDate(when),
        amount: amt,                       // already signed: - out, + in
        description: String(t.description ?? "").trim(),
        external_id: "simplefin:" + t.id,
      });
    }
  }
  return { rows, balances, unmapped, txnsSeen, accountsSeen: accounts.length };
}

async function ingest(db: any, rows: any[]) {
  let inserted = 0, skipped = 0;
  const errors: string[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await db.rpc("accountant_ingest", { rows: rows.slice(i, i + 200) });
    if (error) errors.push(error.message);
    else if (data?.[0]) { inserted += data[0].inserted ?? 0; skipped += data[0].skipped ?? 0; }
  }
  return { inserted, skipped, errors };
}

// One update per account: thirteen rows, every four hours. Each also lands in
// accountant_balance_history, one row per account per day (the day's last run
// wins), which the Monarch page charts as net worth over time.
async function saveBalances(db: any, balances: any[]) {
  const errors: string[] = [];
  for (const b of balances) {
    const { error } = await db.from("accountant_accounts")
      .update({ balance: b.balance, balance_as_of: b.as_of }).eq("id", b.id);
    if (error) errors.push("balance " + b.id + ": " + error.message);
  }
  if (balances.length) {
    const { error } = await db.from("accountant_balance_history").upsert(
      balances.map((b) => ({ account_id: b.id, as_of: b.day, balance: b.balance,
        available: b.available, fetched_at: new Date().toISOString() })),
      { onConflict: "account_id,as_of" });
    if (error) errors.push("balance history: " + error.message);
  }
  return errors;
}

// Cloudflare Pages builds used this calendar month (UTC) across every Pages
// project on the account; the free plan allows 500. Rides along on the bank
// sweep because it is the free scheduled job; the page shows the newest count.
// Needs secrets CLOUDFLARE_API_TOKEN (Account > Cloudflare Pages: Read) and
// CLOUDFLARE_ACCOUNT_ID. Never fails the sweep: a problem is returned as text.
const CF_BUILD_LIMIT = 500;
async function cloudflareBuilds() {
  const token = Deno.env.get("CLOUDFLARE_API_TOKEN");
  const account = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
  if (!token || !account) return { error: "Cloudflare secrets not set" };
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const api = "https://api.cloudflare.com/client/v4/accounts/" + account + "/pages/projects";
  const get = async (url: string) => {
    const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) {
      throw new Error("Cloudflare " + res.status + ": " + JSON.stringify(body?.errors ?? "").slice(0, 200));
    }
    return body;
  };
  try {
    const projects = (await get(api)).result ?? [];
    let used = 0;
    for (const p of projects) {
      // newest first; stop at the first page that reaches back past the 1st
      for (let page = 1; page <= 40; page++) {
        const list = (await get(api + "/" + encodeURIComponent(p.name)
          + "/deployments?per_page=25&page=" + page)).result ?? [];
        const inMonth = list.filter((d: any) => Date.parse(d.created_on) >= since.getTime());
        used += inMonth.length;
        if (list.length < 25 || inMonth.length < list.length) break;
      }
    }
    return { used, limit: CF_BUILD_LIMIT, since: since.toISOString().slice(0, 10) };
  } catch (e) {
    return { error: String((e as any)?.message ?? e).slice(0, 240) };
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2),
    { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const started = Date.now();
  const qs = new URL(req.url).searchParams;
  let body: any = {};
  try { body = (await req.json()) ?? {}; } catch (_) { /* no body */ }

  const param = (k: string) => qs.get(k) ?? (body?.[k] != null ? String(body[k]) : null);
  const mode = param("mode") ?? "sweep";
  if (!["dry_run", "sweep"].includes(mode)) {
    return json({ error: "unknown mode: " + mode }, 400);
  }

  const accessUrl = Deno.env.get("SIMPLEFIN_ACCESS_URL");
  if (!accessUrl) return json({ error: "SIMPLEFIN_ACCESS_URL not set" }, 500);

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // verify_jwt is not enough: the page's public key passes it, so anyone who
  // loads the page could run this and read real transactions off a dry run.
  // The pg_cron job sends the Vault secret `bank_feed_key`; nothing else has it.
  const { data: keyOk } = await db.rpc("accountant_feed_key_ok",
    { p_key: req.headers.get("x-bank-feed-key") });
  if (keyOk !== true) return json({ error: "forbidden" }, 403);

  const { base, auth } = splitAccessUrl(accessUrl);

  // One row per sweep in engine_logs, the run log every scheduled job shares.
  // The page raises a Bank problem from the latest one. A dry run logs nothing.
  const log = async (fields: Record<string, unknown>) => {
    if (mode !== "sweep") return;
    await db.from("engine_logs").insert({
      job: "bank_feed",
      started_at: new Date(started).toISOString(),
      finished_at: new Date().toISOString(),
      ...fields,
    });
  };

  const fail = async (msg: string, note: string) => {
    await log({ status: "failed", error: msg, summary: { note } });
    return json({ error: msg }, 502);
  };

  // Zero mapped accounts is never a real state (a failed read once looked like
  // one, 2026-09-14), so stop before anything is written.
  const { data: mapped, error: mappedErr } = await db.from("accountant_accounts")
    .select("id, bank, name, simplefin_account_id")
    .not("simplefin_account_id", "is", null);
  if (mappedErr) return await fail("accounts read: " + mappedErr.message, "startup read failed");
  if (!mapped?.length) return await fail("accounts read returned no mapped accounts", "startup read failed");
  const byExternal = new Map<string, any>(
    mapped.map((r: any) => [r.simplefin_account_id, r]));

  const { data: marks, error: marksErr } = await db.from("accountant_account_watermarks")
    .select("account_id, bank, account, active, linked, txns, last_txn");
  if (marksErr) return await fail("watermarks read: " + marksErr.message, "startup read failed");
  const linked = (marks ?? []).filter((m: any) => m.linked && m.active);

  // ---------------------------------------------------------------- dry_run
  if (mode === "dry_run") {
    const days = Math.min(MAX_WINDOW_DAYS, Math.max(1, Number(param("days")) || 7));
    const w: Window = { start: Math.floor(Date.now() / 1000) - days * DAY, end: null };
    let payload: any;
    try { payload = await fetchWindow(base, auth, w); }
    catch (e) { return await fail(String((e as any)?.message ?? e), "fetch failed"); }

    const feedErrors = feedErrorsOf(payload);
    const { rows, unmapped, txnsSeen, accountsSeen } = mapRows(payload, byExternal);

    return json({
      mode, days, window: { from: toISO(w.start), to: "now" },
      accounts_seen: accountsSeen, txns_seen: txnsSeen, candidates: rows.length,
      unmapped, feed_errors: feedErrors, sample: rows.slice(0, 10),
      ms: Date.now() - started,
    });
  }

  // ------------------------------------------------------------------ sweep
  if (mode === "sweep") {
    // Window comes from the oldest per-account watermark, not a fixed 24h, so
    // an account whose bank posted late still gets picked up. One request
    // covers every account, so the OLDEST watermark sets the window for all.
    const today = toUnix(todayPacific());
    // A linked account with no transactions at all (a crypto wallet,
    // a joint checking account) has no watermark to catch up to, so it does not
    // set the window. It used to force the maximum on every run.
    const withTxns = linked.filter((m: any) => m.last_txn);

    let days: number;
    let basis: string;
    if (withTxns.length === 0) {
      days = MAX_WINDOW_DAYS;
      basis = "no linked account has transactions yet";
    } else {
      const oldest = withTxns
        .map((m: any) => toUnix(m.last_txn))
        .reduce((a: number, b: number) => Math.min(a, b));
      const raw = Math.ceil((today - oldest) / DAY) + SWEEP_LOOKBACK_PAD;
      days = Math.min(MAX_WINDOW_DAYS, Math.max(SWEEP_MIN_DAYS, raw));
      basis = "oldest watermark " + toISO(oldest) + " + " + SWEEP_LOOKBACK_PAD + "d pad";
    }

    const now = Math.floor(Date.now() / 1000);
    const w: Window = { start: Math.max(today - days * DAY, now - MAX_WINDOW_DAYS * DAY), end: null };
    let payload: any;
    try { payload = await fetchWindow(base, auth, w); }
    catch (e) { return await fail(String((e as any)?.message ?? e), "fetch failed"); }

    const errors = feedErrorsOf(payload);
    const { rows, balances, unmapped, txnsSeen, accountsSeen } = mapRows(payload, byExternal);
    const ing = await ingest(db, rows);
    errors.push(...ing.errors);
    errors.push(...await saveBalances(db, balances));
    if (unmapped.length) errors.push("unmapped accounts skipped: " + unmapped.join(", "));

    await log({
      status: errors.length ? "failed" : "ok",
      counts: {
        accounts_seen: accountsSeen, txns_seen: txnsSeen,
        rows_inserted: ing.inserted, rows_skipped: ing.skipped,
        balances: balances.length,
      },
      summary: { note: days + "d window (" + basis + ")", cloudflare: await cloudflareBuilds() },
      error: errors.length ? errors.join("; ") : null,
    });

    return json({
      mode, days, basis, window: { from: toISO(w.start), to: "now" },
      accounts_seen: accountsSeen, txns_seen: txnsSeen, candidates: rows.length,
      inserted: ing.inserted, skipped: ing.skipped, errors,
      ms: Date.now() - started,
    });
  }

  return json({ error: "unreachable mode: " + mode }, 400);
});
