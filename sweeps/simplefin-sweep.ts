// accountant-simplefin-sweep — the only writer of accountant_transactions.
//
// Deployed as a Supabase edge function on project <your-project-ref>. No
// Claude routine touches the accountant tables; this function loads them, the
// `accountant` skill curates them on demand, and the page reads them.
//
// Modes
//   dry_run  — fetch a short window, map it, write nothing. Only the reply
//              says what it saw, so a test never looks like a sync.
//   sweep    — the pg_cron job, every four hours. Window derived from the oldest per-account
//              watermark minus 5 days, clamped to [14, 90] days. One request.
//
// There was a third mode, `backfill`, which walked 90-day windows backwards
// from a cursor in accountant_backfill_state. It finished, the table was
// dropped on 2026-09-15, and the mode went with it. Anything older than the
// feed reaches now comes from a bank CSV through accountant_ingest.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const PACIFIC = "America/Los_Angeles";
const DAY = 86400;
const MAX_WINDOW_DAYS = 90;   // SimpleFIN's per-request span limit
const SWEEP_LOOKBACK_PAD = 5; // re-pull this many days behind the watermark
const SWEEP_MIN_DAYS = 14;
// Pending charges are carried. Excluding them held the table two to three days
// behind every card, which read as a dead feed rather than the settlement lag
// it was. They are provisional — the amount can move, and some never settle —
// so a pending row stays rewritable and a settled one does not.

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
  const qs = new URLSearchParams({ "start-date": String(w.start), pending: "1" });
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
    for (const t of txns) {
      const amt = Number(t.amount);
      if (!isFinite(amt) || amt === 0) continue;
      const pending = !!t.pending;
      // `posted` is 0 until a charge settles, and pacificDate(0) is 1969.
      // transacted_at is when it actually happened, which is the date he
      // recognises anyway.
      const when = Number(t.posted) || Number(t.transacted_at) || 0;
      if (!when) continue;
      rows.push({
        account_id: acct.id,
        date: pacificDate(when),
        amount: amt,                       // already signed: - out, + in
        description: String(t.description ?? "").trim(),
        source: "simplefin",
        external_id: "simplefin:" + t.id,
        pending,
      });
    }
  }
  return { rows, unmapped, txnsSeen, accountsSeen: accounts.length };
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

  // A failed or empty read here once turned every account "unmapped" and let
  // the prune delete every pending row (2026-09-14). Zero mapped accounts is
  // never a real state, so stop before anything is written.
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
    const withTxns = linked.filter((m: any) => m.last_txn);
    const anyEmpty = linked.length !== withTxns.length;

    let days: number;
    let basis: string;
    if (anyEmpty || withTxns.length === 0) {
      days = MAX_WINDOW_DAYS;
      basis = "at least one linked account has no transactions yet";
    } else {
      const oldest = withTxns
        .map((m: any) => toUnix(m.last_txn))
        .reduce((a: number, b: number) => Math.min(a, b));
      const raw = Math.ceil((today - oldest) / DAY) + SWEEP_LOOKBACK_PAD;
      days = Math.min(MAX_WINDOW_DAYS, Math.max(SWEEP_MIN_DAYS, raw));
      basis = "oldest watermark " + toISO(oldest) + " + " + SWEEP_LOOKBACK_PAD + "d pad";
    }

    const w: Window = { start: today - days * DAY, end: null };
    let payload: any;
    try { payload = await fetchWindow(base, auth, w); }
    catch (e) { return await fail(String((e as any)?.message ?? e), "fetch failed"); }

    const errors = feedErrorsOf(payload);
    const { rows, unmapped, txnsSeen, accountsSeen } = mapRows(payload, byExternal);
    const ing = await ingest(db, rows);
    errors.push(...ing.errors);
    if (unmapped.length) errors.push("unmapped accounts skipped: " + unmapped.join(", "));

    // A pending charge the bank has dropped never settles. Anything still
    // pending inside the window just covered, that the feed no longer lists,
    // is deleted — so the table matches what the bank says right now.
    // A run that mapped no account has no idea what is pending, so it prunes nothing.
    const keep = rows.filter((r: any) => r.pending).map((r: any) => r.external_id);
    let pruned: any = 0;
    if (accountsSeen > unmapped.length) {
      const { data, error: pruneErr } = await db.rpc("accountant_prune_pending", {
        since: toISO(w.start), keep,
      });
      pruned = data;
      if (pruneErr) errors.push("prune pending: " + pruneErr.message);
    } else {
      errors.push("prune pending skipped: no account mapped");
    }

    await log({
      status: errors.length ? "failed" : "ok",
      counts: {
        accounts_seen: accountsSeen, txns_seen: txnsSeen,
        rows_inserted: ing.inserted, rows_skipped: ing.skipped,
        pending_dropped: pruned ?? 0,
      },
      summary: { note: days + "d window (" + basis + ")" },
      error: errors.length ? errors.join("; ") : null,
    });

    return json({
      mode, days, basis, window: { from: toISO(w.start), to: "now" },
      accounts_seen: accountsSeen, txns_seen: txnsSeen, candidates: rows.length,
      inserted: ing.inserted, skipped: ing.skipped,
      pending: keep.length, pending_dropped: pruned ?? 0, errors,
      ms: Date.now() - started,
    });
  }

  return json({ error: "unreachable mode: " + mode }, 400);
});
