// mail-watch: the Apps Script's one door into the database, and the only
// thing that sends push.
//
// Deployed as a Supabase edge function with verify_jwt off: the Apps Script
// has no Supabase session. The lock is the x-watch-key header, checked against
// the Vault secret mail_watch_key by engine_watch_key_ok().
//
// Ops (POST JSON)
//   pull : engine_watch_pull(): queued Gmail work, blocked senders, the rules' lists
//   push : engine_watch_push(): what the script did and found; each urgent
//           message becomes a Requires Action row. mail-sort.ts decides where
//           each new message goes (returned as `sort`) and which new rows push:
//           a reply to his mail, or a person asking him to answer
//   test : push "Mail watch is connected" to every phone, to check the chain

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { generateVapid, sendPush, type Subscription } from "./webpush.ts";
import { choosePushes, guardFiling, isSecurityNoise, pushWithoutModel, type Raised, sortMail } from "./mail-sort.ts";

const SUBJECT = "https://norns-demo.example.com";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

async function rpc(name: string, args?: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(name + ": " + error.message);
  return data;
}

// Made on first use and kept in Vault, so no person ever handles the private key.
async function vapid() {
  const v = await rpc("engine_vapid");
  if (v?.public && v?.private) return { publicKey: v.public, privateKey: v.private, subject: SUBJECT };
  const made = await generateVapid();
  await rpc("engine_vapid_set", { p_public: made.publicKey, p_private: made.privateKey });
  return { ...made, subject: SUBJECT };
}

// badge left out leaves the icon's number as it is
async function pushAll(messages: { title: string; body: string; tag?: string }[], badge?: number) {
  if (!messages.length) return { sent: 0, dropped: 0, failed: 0 };
  const keys = await vapid();
  const { data: subs, error } = await db.from("engine_push_subs").select("endpoint, p256dh, auth");
  if (error) throw new Error("engine_push_subs: " + error.message);
  let sent = 0, dropped = 0, failed = 0;
  for (const sub of (subs ?? []) as Subscription[]) {
    for (const m of messages) {
      let status = 0;
      try {
        status = await sendPush(sub, { ...m, badge, url: "/" }, keys);
      } catch (_) { status = 0; }
      if (status === 404 || status === 410) {
        await db.from("engine_push_subs").delete().eq("endpoint", sub.endpoint);
        dropped++;
        break;
      }
      if (status >= 200 && status < 300) {
        sent++;
        await db.from("engine_push_subs").update({ last_ok: new Date().toISOString() })
          .eq("endpoint", sub.endpoint);
      } else {
        failed++;
      }
    }
  }
  return { sent, dropped, failed };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  const ok = await rpc("engine_watch_key_ok", { p_key: req.headers.get("x-watch-key") ?? "" })
    .catch(() => false);
  if (!ok) return reply(403, { error: "forbidden" });

  try {
    const body = await req.json();
    if (body.op === "pull") {
      await vapid(); // so the page has a key to subscribe with from the first run
      return reply(200, await rpc("engine_watch_pull"));
    }
    if (body.op === "push") {
      // codes and sign-in notices never reach Requires Action
      body.items = (body.items ?? []).filter((i: { reason?: string; subject?: string }) => !isSecurityNoise(i));
      const res = await rpc("engine_watch_push", { p: body });
      // Where each new message goes. In shadow mode this is only recorded;
      // the script files by it once engine_mail_watch.mode is 'live'.
      // deno-lint-ignore no-explicit-any
      let sort: any = null;
      try {
        sort = await sortMail(rpc, body.messages ?? []);
        sort.decided = guardFiling(sort.decided ?? [], res.open_threads ?? []);
      } catch (e) {
        sort = { error: String((e as Error)?.message ?? e).slice(0, 300), decided: [] };
      }
      // Every new row is on Requires Action; only replies and people asking
      // for an answer reach the phone. Past the month's cap, the plain rule.
      const raised = res.pushes ?? [];
      let chosen;
      try {
        chosen = await choosePushes(rpc, raised, body.messages ?? [], Number(sort?.left ?? 0));
      } catch (_) {
        chosen = raised.filter(pushWithoutModel)
          .map(({ title, body, tag }: Raised) => ({ title, body, tag }));
      }
      const push = await pushAll(chosen, Number(res.badge) || 0);
      return reply(200, { raised: raised.length, pushed: chosen.length, ...push, sort });
    }
    if (body.op === "test") {
      return reply(200, await pushAll([{ title: "Mail watch", body: "Mail watch is connected", tag: "test" }]));
    }
    return reply(400, { error: "unknown op" });
  } catch (e) {
    return reply(500, { error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
});
