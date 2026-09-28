// rentals-sweep — the only writer of rentals_listings. Temporary: it goes,
// with its tables and its cron job, once a place is found.
//
// Deployed as a Supabase edge function on project <your-project-ref> with
// two steps, each its own pg_cron job: ?step=feed once a morning finds the
// listings, and ?step=vet every 10 minutes all day reads them (see
// "vetting" below). Both work from the one row in rentals_search, so a chat
// that edits that row changes the next run.
//
// Two kinds of run. A full pull of every active match is the only run that may
// mark a house gone or see a price change. While the last one fit on one page
// (500), every run is full: one request, the same as asking only for what is
// new. Past 500 — 841 at $3,500 on 2026-09-25 — a full pull runs weekly and the
// other mornings ask only for listings up to three days old, since daily full
// pulls of two pages would cost 60 a month against a free 50.
//
// RentCast bills per 200 response and has no hard cap of its own, so the run
// counts the requests logged since the plan's reset day and stops at
// rentals_search.request_cap.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://api.rentcast.io/v1/listings/rental/long-term";
const PAGE = 500; // RentCast's largest page
const PACIFIC = "America/Los_Angeles";

const todayPacific = () => new Date().toLocaleDateString("en-CA", { timeZone: PACIFIC });

// The last date whose day of the month is the reset day, today included.
function periodStart(resetDay: number) {
  const [y, m, d] = todayPacific().split("-").map(Number);
  const start = d >= resetDay ? new Date(Date.UTC(y, m - 1, resetDay))
                              : new Date(Date.UTC(y, m - 2, resetDay));
  return start.toISOString().slice(0, 10);
}

const addressKey = (line1: string, zip: string) =>
  (line1 + zip).toLowerCase().replace(/[^a-z0-9]/g, "");

// RentCast has no listing link; a Zillow address search lands on the house.
const zillow = (formatted: string) =>
  "https://www.zillow.com/homes/" + encodeURI(formatted.trim().replace(/\s+/g, "-")) + "_rb/";

// The unit is part of the address: apartments in one complex share a street
// line, and without it every unit in a building would dedupe into one row.
function mapRow(l: any) {
  const line1 = [l.addressLine1, l.addressLine2].map((x) => String(x ?? "").trim())
    .filter(Boolean).join(" ");
  const zip = String(l.zipCode ?? "").trim();
  const agent = l.listingAgent ?? {};
  const office = l.listingOffice ?? {};
  return {
    rentcast_id: String(l.id),
    address_key: addressKey(line1, zip),
    address: line1,
    city: l.city ?? null,
    zip: zip || null,
    latitude: l.latitude ?? null,
    longitude: l.longitude ?? null,
    price: l.price ?? null,
    beds: l.bedrooms ?? null,
    baths: l.bathrooms ?? null,
    sqft: l.squareFootage ?? null,
    listed_date: l.listedDate ? String(l.listedDate).slice(0, 10) : null,
    days_on_market: l.daysOnMarket ?? null,
    agent_name: agent.name ?? office.name ?? null,
    agent_phone: agent.phone ?? office.phone ?? null,
    agent_email: agent.email ?? office.email ?? null,
    url: l.formattedAddress ? zillow(String(l.formattedAddress)) : null,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2),
    { status, headers: { "Content-Type": "application/json" } });

// ------------------------------------------------------------------ vetting
// RentCast has no description, so its list is only what Zillow's own filters
// show. The vet step reads each house the way Alex would: Apify fetches the
// Zillow listing (description, laundry and cooling facts, photos, link),
// Gemini answers four questions about it as rentals_search.vet_rules defines
// them, and decide() turns the answers into pass, unsure or fail. A fail is
// dismissed with its reason; the page shows only pass and unsure.
//
// It runs every 10 minutes all day and does a little each time,
// so no single call nears the edge function's time limit:
//   1. a finished Apify run is collected into the listings;
//   2. with none running, one is started for one unit of every building
//      still without details, plus a daily recheck of every Filtered or
//      saved house (Zillow no longer listing it for rent means it is taken:
//      zillow_gone_on, so the page drops it the same day rather than at the
//      weekly full RentCast pull);
//   3. up to VET_BATCHES Gemini calls of VET_PER_CALL buildings each.
//
// A building is read once: its units share the listing text, laundry and
// cooling, so one unit's details and verdict are copied to the rest. On
// 2026-09-26 the 1,114 listings were 588 buildings. A unit Zillow does not
// have is not tried again, and neither is the rest of its building.

const APIFY = "https://api.apify.com/v2";
const VET_PER_CALL = 10;
const VET_BATCHES = 4;

// Field names are this scraper's (maxcopell~zillow-detail-scraper), read off
// a real run on 2026-09-25. atAGlanceFacts is Zillow's own fact box: Type,
// Cooling, Heating, Pets, Parking, Laundry.
const glance = (it: any) => {
  const out: Record<string, string> = {};
  for (const f of Array.isArray(it.atAGlanceFacts) ? it.atAGlanceFacts : []) {
    if (f?.factLabel && f.factValue) out[f.factLabel] = String(f.factValue);
  }
  return out;
};

const list = (v: any) =>
  Array.isArray(v) && v.length ? v.filter(Boolean).join(", ") : null;

function mapDetails(it: any) {
  const g = glance(it);
  const pf = it.propertyFeatures ?? {};
  // A listing with no photos gets Zillow's own Street View link as its main
  // image; only Zillow's photo host counts, and the page falls back to ours.
  // Every Zillow photo comes in sizes by suffix; -p_c is 316x234, about 23 KB,
  // where the listing's own link is 1536 wide.
  const photo = [it.mainImage?.hiRes, it.listingPhotos?.[0]?.url]
    .map((u) => /^(https:\/\/photos\.zillowstatic\.com\/fp\/[0-9a-f]+)-[^/]*\.jpg$/.exec(String(u ?? "")))
    .find(Boolean)?.[1];
  const thumb = photo ? photo + "-p_c.jpg" : null;
  const facts = [
    ["Status", it.listingStatus], ["Type", g.Type ?? it.homeType], ["Laundry", g.Laundry],
    ["Appliances", list(pf.appliances)], ["Cooling", g.Cooling ?? list(pf.cooling)],
    ["Heating", g.Heating ?? list(pf.heating)], ["Parking", g.Parking], ["Pets", g.Pets],
    ["Price", it.listingPrice?.formatted],
  ].filter(([, v]) => v).map(([k, v]) => k + ": " + v).join("; ");
  return {
    zillow_url: typeof it.propertyUrl === "string" && it.propertyUrl.startsWith("https://") ? it.propertyUrl : null,
    photo: thumb,
    home_type: it.homeType ?? null,
    laundry: g.Laundry ?? null,
    cooling: g.Cooling ?? list(pf.cooling),
    facts: facts || null,
    // Zillow's rent, where it lists the house for rent; RentCast's can be
    // far off (one house: $1,850 there, $3,250 on Zillow), and a
    // for-sale page's price is the sale price
    zillow_price: it.listingStatus === "forRent" && Number(it.listingPrice?.amount) > 0
      && Number(it.listingPrice.amount) < 20000 ? Math.round(Number(it.listingPrice.amount)) : null,
    description: it.description ? String(it.description).slice(0, 6000) : null,
    valid: it.isValid !== false,
  };
}

// What the feed sends as an address, which the scraper echoes back as
// addressOrUrlFromInput: the one reliable way to pair a result with a house.
const inputOf = (l: any) => l.address + ", " + (l.city ?? "") + ", CA " + (l.zip ?? "");

async function apify(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(APIFY + path + (path.includes("?") ? "&" : "?") + "token=" + token, init);
  if (!res.ok) throw new Error("Apify " + res.status + ": " + (await res.text()).slice(0, 300));
  return await res.json();
}

// limit and peek are for a hand-run test: start a run for only the first
// `limit` houses, and return one raw Apify item when a run is collected.
async function vet(db: any, s: any, log: (f: Record<string, unknown>) => Promise<void>,
                   fail: (m: string, c?: Record<string, unknown>) => Promise<Response>,
                   limit: number, peek: boolean) {
  const token = Deno.env.get("APIFY_TOKEN");
  const gemini = Deno.env.get("GEMINI_API_KEY");
  if (!token || !gemini) return json({ error: "APIFY_TOKEN or GEMINI_API_KEY not set" }, 500);
  const c: Record<string, number> = { details_found: 0, details_missing: 0, started: 0,
                                      rechecked: 0, went_off_zillow: 0,
                                      gemini_calls: 0, pass: 0, unsure: 0, fail: 0 };
  let sample: unknown = undefined;
  let limited: string | undefined;
  const today = todayPacific();
  const now = () => new Date().toISOString();
  const dayOf = (t: string | null) =>
    t ? new Date(t).toLocaleDateString("en-CA", { timeZone: PACIFIC }) : "";

  // 1. collect a finished run
  if (s.apify_run_id) {
    let run: any;
    try { run = (await apify("/actor-runs/" + s.apify_run_id, token)).data; }
    catch (e) { return await fail(String((e as any).message), { kind: "vet" }); }
    if (run.status === "SUCCEEDED") {
      let items: any[];
      try { items = await apify("/datasets/" + run.defaultDatasetId + "/items?clean=true", token); }
      catch (e) { return await fail(String((e as any).message), { kind: "vet" }); }
      if (peek) sample = items[0] ?? null;
      const { data: batch, error } = await db.from("rentals_listings")
        .select("id, address, city, zip, building_key, details_status, facts").in("id", s.apify_batch ?? []);
      if (error) return await fail("batch read: " + error.message, { kind: "vet" });
      const byInput = new Map<string, any>(
        items.map((it: any) => [String(it.addressOrUrlFromInput ?? ""), it]));
      for (const l of batch ?? []) {
        const it = byInput.get(inputOf(l));
        let err: any = null;
        if (l.details_status === "found") {
          // the daily recheck: only Zillow's status and rent are read again
          c.rechecked++;
          const patch: Record<string, unknown> = { details_at: now() };
          // taken means Zillow listed it for rent before and does not now; a
          // page never listed for rent says nothing either way
          const wasForRent = /^Status: forRent/.test(l.facts ?? "");
          if (it && wasForRent && it.listingStatus && it.listingStatus !== "forRent") {
            patch.zillow_gone_on = today;
            c.went_off_zillow++;
          } else if (it) {
            patch.zillow_gone_on = null;
            const d = mapDetails(it);
            if (d.zillow_price) patch.zillow_price = d.zillow_price;
          }
          ({ error: err } = await db.from("rentals_listings").update(patch).eq("id", l.id));
        } else {
          const d = it ? mapDetails(it) : null;
          const found = !!(d && d.valid && (d.description || d.facts));
          const shared = found
            ? { zillow_url: d!.zillow_url, photo: d!.photo, home_type: d!.home_type,
                laundry: d!.laundry, cooling: d!.cooling, facts: d!.facts,
                description: d!.description, details_status: "found", details_at: now() }
            : { details_status: "missing", details_at: now() };
          ({ error: err } = await db.from("rentals_listings")
            .update({ ...shared, zillow_price: found ? d!.zillow_price : null }).eq("id", l.id));
          // the rest of the building takes the same details; its rents are its own
          if (!err) {
            ({ error: err } = await db.from("rentals_listings").update(shared)
              .eq("building_key", l.building_key).is("details_status", null).neq("id", l.id));
          }
          c[found ? "details_found" : "details_missing"]++;
        }
        if (err) return await fail("details write: " + err.message, { kind: "vet" });
      }
      await db.from("rentals_search").update({ apify_run_id: null, apify_batch: null }).eq("id", 1);
      s.apify_run_id = null;
    } else if (["FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) {
      await db.from("rentals_search").update({ apify_run_id: null, apify_batch: null }).eq("id", 1);
      return await fail("Apify run " + run.status.toLowerCase(), { kind: "vet" });
    }
  }

  // 2. start a run: one unit of each building still without details, and
  //    the daily recheck of Filtered and saved houses not yet read today
  if (!s.apify_run_id) {
    const { data: fresh, error } = await db.from("rentals_listings")
      .select("id, address, city, zip, building_key")
      .is("dismissed_at", null).is("gone_on", null).is("details_status", null)
      .order("id").limit(2000);
    if (error) return await fail("todo read: " + error.message, { kind: "vet" });
    const seen = new Set<string>();
    const firsts = (fresh ?? []).filter((l: any) => {
      if (seen.has(l.building_key)) return false;
      seen.add(l.building_key);
      return true;
    });
    const { data: keep, error: kErr } = await db.from("rentals_listings")
      .select("id, address, city, zip, details_at")
      .is("dismissed_at", null).is("gone_on", null).is("zillow_gone_on", null)
      .eq("details_status", "found").or("verdict.eq.pass,status.neq.new");
    if (kErr) return await fail("recheck read: " + kErr.message, { kind: "vet" });
    const recheck = (keep ?? []).filter((l: any) => dayOf(l.details_at) < today);
    const due = [...recheck, ...firsts].slice(0, limit);
    if (due.length) {
      let run: any;
      try {
        run = (await apify("/acts/" + s.apify_actor + "/runs", token, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addresses: due.map(inputOf), propertyStatus: "FOR_RENT" }),
        })).data;
      } catch (e) { return await fail(String((e as any).message), { kind: "vet" }); }
      await db.from("rentals_search").update({ apify_run_id: run.id, apify_batch: due.map((l: any) => l.id) }).eq("id", 1);
      c.started = due.length;
    }
  }

  // 3. judge one unit per building that has details and no verdict, and
  //    give the whole building its verdict
  const { data: readyAll, error: rErr } = await db.from("rentals_listings")
    .select("id, address, city, price, beds, baths, sqft, facts, description, building_key")
    .eq("details_status", "found").is("verdict", null).is("dismissed_at", null)
    .order("id").limit(1000);
  if (rErr) return await fail("ready read: " + rErr.message, { kind: "vet" });
  const judged = new Set<string>();
  const ready = (readyAll ?? []).filter((l: any) => {
    if (judged.has(l.building_key)) return false;
    judged.add(l.building_key);
    return true;
  }).slice(0, VET_PER_CALL * VET_BATCHES);
  for (let i = 0; i < ready.length; i += VET_PER_CALL) {
    const houses = ready.slice(i, i + VET_PER_CALL)
      .map(({ building_key, ...h }: any) => h);
    let verdicts: any[];
    try { verdicts = await judge(gemini, s.gemini_model, s.vet_rules, houses); c.gemini_calls++; }
    catch (e) {
      // the free tier's limits (429) and Google's own overload (503) pass: the
      // rest wait for a later tick
      if (/^Gemini (429|503)/.test(String((e as any).message))) {
        limited = String((e as any).message).slice(0, 300);
        break;
      }
      await log({ status: "failed", error: String((e as any).message), counts: { kind: "vet", ...c } });
      return json({ error: String((e as any).message), ...c }, 502);
    }
    for (const a of verdicts) {
      const h = ready.find((x: any) => x.id === Number(a.id));
      if (!h) continue;
      const v = decide(a, h.facts);
      const reason = v.reason.slice(0, 200) || null;
      const patch: Record<string, unknown> = {
        verdict: v.verdict, verdict_reason: reason, vetted_at: now(),
        notes: String(a.summary ?? "").slice(0, 1000) || null,
        landlord: ANSWERS.landlord.includes(a.landlord) ? a.landlord : null,
        income_rule: ANSWERS.income_rule.includes(a.income_rule) ? a.income_rule : null,
        apply_note: String(a.apply_note ?? "").trim().slice(0, 120) || null,
      };
      if (v.verdict === "fail") {
        patch.dismissed_at = now();
        patch.dismiss_reason = ("Vetting: " + (reason ?? "failed")).slice(0, 200);
      }
      const { error } = await db.from("rentals_listings").update(patch)
        .eq("building_key", h.building_key).eq("details_status", "found")
        .is("verdict", null).is("dismissed_at", null);
      if (error) return await fail("verdict write: " + error.message, { kind: "vet", ...c });
      c[v.verdict]++;
    }
  }

  // an idle tick writes nothing, so the log is not ten rows of nothing an hour
  if (c.details_found + c.details_missing + c.started + c.rechecked + c.gemini_calls > 0) {
    await log({ status: "ok", counts: { kind: "vet", ...c },
      summary: { note: "vet: " + c.pass + " pass, " + c.unsure + " unsure, " + c.fail + " fail, " +
                       c.went_off_zillow + " off Zillow" } });
  }
  return json({ kind: "vet", ...c, limited, sample });
}

// Gemini only reads: it answers questions per house, and decide() turns the
// four must-have answers into the verdict. Asked for a verdict directly, it
// passed houses its own summary said had no AC (2026-09-25). landlord,
// income_rule and apply_note decide nothing: the page sorts and labels by
// them, since with savings and no income a private owner or a listing that
// takes a co-signer is the better bet.
const ANSWERS = {
  laundry: ["own", "hookups", "shared", "unknown"],
  ac: ["yes", "swamp_only", "no", "unknown"],
  whole_home: ["yes", "no"],
  adu: ["yes", "no"],
  landlord: ["private", "manager", "complex", "unknown"],
  income_rule: ["strict", "flexible", "none_stated"],
};

function decide(a: any, facts: string | null) {
  const fails: string[] = [], unsure: string[] = [];
  if (a.laundry === "shared") fails.push("Shared laundry");
  // hookups are fine: the renter brings the machines (2026-09-26)
  if (a.laundry === "unknown" || !ANSWERS.laundry.includes(a.laundry)) unsure.push("Laundry not mentioned");
  if (a.ac === "no") fails.push("No AC");
  if (a.ac === "swamp_only") fails.push("Swamp cooler only");
  if (a.ac === "unknown" || !ANSWERS.ac.includes(a.ac)) unsure.push("AC not mentioned");
  if (a.whole_home === "no") fails.push("Room or shared home");
  if (a.adu === "yes") fails.push("ADU or back unit");
  if (!/Status: forRent/.test(facts ?? "")) unsure.push("Not a current Zillow rental");
  if (fails.length) return { verdict: "fail", reason: fails.join(", ") };
  if (unsure.length) return { verdict: "unsure", reason: unsure.join(", ") };
  return { verdict: "pass", reason: "" };
}

async function judge(key: string, model: string, rules: string, houses: any[]) {
  const prompt = "You read rental listings for a renter who does not want to read them. " +
    "For each house, answer from its facts (Zillow's own fact box) and its description.\n\n" +
    rules + "\n\nAlso write a summary of at most 200 characters a renter would want: laundry, " +
    "cooling, parking, yard, pets, and anything suspicious or contradictory.\n\nHouses:\n" +
    JSON.stringify(houses);
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model +
    ":generateContent?key=" + key, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: { type: "ARRAY", items: { type: "OBJECT", properties: {
          id: { type: "INTEGER" },
          laundry: { type: "STRING", enum: ANSWERS.laundry },
          ac: { type: "STRING", enum: ANSWERS.ac },
          whole_home: { type: "STRING", enum: ANSWERS.whole_home },
          adu: { type: "STRING", enum: ANSWERS.adu },
          landlord: { type: "STRING", enum: ANSWERS.landlord },
          income_rule: { type: "STRING", enum: ANSWERS.income_rule },
          apply_note: { type: "STRING" },
          summary: { type: "STRING" } },
          required: ["id", "laundry", "ac", "whole_home", "adu", "landlord", "income_rule",
                     "apply_note", "summary"] } },
      },
    }),
  });
  if (!res.ok) throw new Error("Gemini " + res.status + ": " + (await res.text()).slice(0, 300));
  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  const out = JSON.parse(text ?? "[]");
  if (!Array.isArray(out)) throw new Error("Gemini returned no list");
  return out;
}

Deno.serve(async (req: Request) => {
  const started = Date.now();
  const step = new URL(req.url).searchParams.get("step") ?? "feed";
  if (!["feed", "vet"].includes(step)) return json({ error: "unknown step: " + step }, 400);

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Same gate as the bank feed: verify_jwt passes the page's public key, so
  // only the pg_cron job's Vault secret may run this.
  const { data: keyOk } = await db.rpc("accountant_feed_key_ok",
    { p_key: req.headers.get("x-bank-feed-key") });
  if (keyOk !== true) return json({ error: "forbidden" }, 403);

  let requests = 0;
  const log = async (fields: Record<string, unknown>) => {
    await db.from("engine_logs").insert({
      job: "rental_feed",
      started_at: new Date(started).toISOString(),
      finished_at: new Date().toISOString(),
      ...fields,
    });
  };
  const fail = async (msg: string, counts: Record<string, unknown> = {}) => {
    await log({ status: "failed", error: msg, counts: { requests, ...counts } });
    return json({ error: msg, requests }, 502);
  };

  const { data: s, error: sErr } = await db.from("rentals_search").select("*").eq("id", 1).single();
  if (sErr || !s) return await fail("search read: " + (sErr?.message ?? "no row"));
  if (step === "vet") {
    const q = new URL(req.url).searchParams;
    return await vet(db, s, log, fail, Number(q.get("limit")) || 500, q.get("peek") === "1");
  }

  const apiKey = Deno.env.get("RENTCAST_API_KEY");
  if (!apiKey) return json({ error: "RENTCAST_API_KEY not set" }, 500);

  const since = periodStart(s.quota_reset_day);
  const { data: past, error: pErr } = await db.from("engine_logs")
    .select("counts").eq("job", "rental_feed").gte("started_at", since + "T07:00:00Z");
  if (pErr) return await fail("request count read: " + pErr.message);
  const used = (past ?? []).reduce((n: number, r: any) => n + (Number(r.counts?.requests) || 0), 0);

  // full when the last one fit on one page, the search has changed since, or
  // none has succeeded in seven days
  const { data: lastFull, error: fErr } = await db.from("engine_logs")
    .select("started_at, counts").eq("job", "rental_feed").eq("status", "ok")
    .eq("counts->>kind", "full").order("started_at", { ascending: false }).limit(1);
  if (fErr) return await fail("last full pull read: " + fErr.message);
  const last = lastFull?.[0];
  const kind = !last || Number(last.counts?.total) <= PAGE
    || Date.parse(s.updated_at) > Date.parse(last.started_at)
    || Date.parse(last.started_at) < Date.now() - 7 * 86400000 + 3600000 ? "full" : "new";

  const listings: any[] = [];
  let total: number | null = null;
  for (let offset = 0; total === null || offset < total; offset += PAGE) {
    if (used + requests >= s.request_cap) {
      if (requests === 0) {
        await log({ status: "skipped", counts: { requests: 0, used },
          summary: { note: used + " of " + s.request_cap + " requests used since " + since } });
        return json({ skipped: true, used, cap: s.request_cap, since });
      }
      // a partial pull cannot say what is gone, so it is a failure, not a run
      return await fail("request cap reached mid-pull at offset " + offset, { kind, used });
    }
    const qs = new URLSearchParams({
      latitude: String(s.latitude), longitude: String(s.longitude),
      radius: String(s.radius_mi), propertyType: s.property_type,
      price: "1:" + s.max_price, squareFootage: s.min_sqft + ":100000",
      status: "Active", limit: String(PAGE), offset: String(offset),
      includeTotalCount: "true",
    });
    if (kind === "new") qs.set("daysOld", "1:3");
    let res: Response;
    try { res = await fetch(API + "?" + qs, { headers: { "X-Api-Key": apiKey, Accept: "application/json" } }); }
    catch (e) { return await fail("RentCast fetch: " + String((e as any)?.message ?? e)); }
    if (!res.ok) {
      // a 403 is billing (subscription inactive), never "no listings"
      return await fail("RentCast " + res.status + ": " + (await res.text()).slice(0, 300));
    }
    requests++;
    const page = await res.json();
    if (!Array.isArray(page)) return await fail("RentCast returned no list");
    listings.push(...page);
    total = Number(res.headers.get("X-Total-Count") ?? listings.length);
    if (page.length < PAGE) break;
  }

  // Apartments are in the search, so a unit number is no longer a reason to
  // drop a listing (2026-09-26); a back unit or a room in a shared house is
  // the vet step's to catch, from the listing itself.
  const rows = listings.filter((l) => l.addressLine1).map(mapRow);

  const { data: ing, error: iErr } = await db.rpc("rentals_ingest",
    { p_rows: rows, p_complete: kind === "full" });
  if (iErr) return await fail("ingest: " + iErr.message, { kind, total, seen: listings.length });

  const counts = { kind, requests, used: used + requests, total, seen: listings.length, ...ing };
  await log({ status: "ok", counts,
    summary: { note: kind + " pull, " + requests + " request(s); " + (used + requests) + " of " + s.request_cap + " since " + since } });
  return json({ ...counts, ms: Date.now() - started });
});
