// Checks for the mail watch that need no Google account and no network:
// node sweeps/mail-watch.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { b64u, unb64u, encrypt, generateVapid, vapidAuth } from "./webpush.ts";

const require = createRequire(import.meta.url);
const gs = require("./mail-watch.js");
const enc = new TextEncoder();
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("ok   " + name); }

// ---- Web Push: RFC 8291 section 5, byte for byte ----
await check("encrypt matches RFC 8291's example", async () => {
  const body = await encrypt(
    enc.encode("When I grow up, I want to be a watermelon"),
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    "BTBZMqHH6r4Tts7J_aSIgg",
    {
      asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
      asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
      salt: "DGv6ra1nlYgDCS1FRnbzlw",
    });
  assert.equal(b64u(body),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

// ---- Web Push: a browser's side decrypts what a random key sends ----
async function hkdf(salt, ikm, info, n) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, n * 8));
}
await check("a fresh message decrypts on the receiving side", async () => {
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const msg = JSON.stringify({ title: "Needs you", badge: 3 });
  const body = await encrypt(enc.encode(msg), b64u(uaPub), b64u(auth));
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPub, ...asPub]);
  const ikm = await hkdf(auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
  assert.equal(plain[plain.length - 1], 2);
  assert.equal(new TextDecoder().decode(plain.slice(0, -1)), msg);
});

await check("the VAPID token verifies with its public key", async () => {
  const v = await generateVapid();
  assert.equal(unb64u(v.publicKey).length, 65);
  const h = await vapidAuth("https://web.push.apple.com/abc", v.publicKey, v.privateKey, "https://norns-demo.example.com");
  const [, t, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, v.publicKey);
  const [head, body, sig] = t.split(".");
  const claims = JSON.parse(new TextDecoder().decode(unb64u(body)));
  assert.equal(claims.aud, "https://web.push.apple.com");
  const pub = await crypto.subtle.importKey("raw", unb64u(v.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(sig), enc.encode(head + "." + body)));
});

// ---- the Apps Script's rules, on mail like the real inbox ----
const cfg = {
  alert_domains: ["homes.example.com", "forms.example.com", "jobs.example.org"],
  self: ["alex@example.com", "alex.other@example.com"],
  blocked: ["pushy@example.net"],
};
const m = (o) => Object.assign({ from: "", name: "", subject: "", text: "", listUnsub: false,
  precedence: "", primary: false, important: false }, o);
const cases = [
  ["rental agent message through a relay", m({ from: "a1b2c3@convo.homes.example.com", subject: "Re: Message from 100 Main St", listUnsub: true }), "urgent"],
  ["form to sign before a showing", m({ from: "no-reply@app.forms.example.com", subject: "Please sign before your showing today", listUnsub: true }), "urgent"],
  ["showing notice through a relay", m({ from: "showing@relay.homes.example.com", subject: "Your showing is confirmed" }), "urgent"],
  ["job portal message", m({ from: "donotreply@portal.jobs.example.org", subject: "Electronic Messages Received", text: "Your account has received a new electronic message" }), "urgent"],
  ["Sam forwarding an invoice", m({ from: "sam@example.com", subject: "Fwd: Payment due: Invoice #0005", primary: true, important: true }), "urgent"],
  ["planner asking a question", m({ from: "planner@example.com", subject: "Quick question about Saturday", primary: true, important: true }), "urgent"],
  ["card payment declined", m({ from: "alerts@bank.example.com", subject: "Your payment was declined", important: true }), "urgent"],
  ["vendor replying to his sent mail", m({ from: "Tent Rentals Co <info@tents.example.com>", subject: "Re: tent placement", text: "the structure won't span the porch", repliedToMine: true }), "urgent"],
  ["bulk mail in a thread he wrote in", m({ from: "news@shop.example.com", subject: "Re: order", listUnsub: true, repliedToMine: true }), null],
  ["no-reply robot in a thread he wrote in", m({ from: "noreply@rides.example.com", subject: "Re: your request", repliedToMine: true }), null],
  ["listing alert", m({ from: "listings@homes.example.com", subject: "3 new homes match your search", listUnsub: true }), null],
  ["newsletter with 'today'", m({ from: "news@shop.example.com", subject: "Today only: 40% off", listUnsub: true, primary: true }), null],
  ["ride receipt", m({ from: "noreply@rides.example.com", subject: "Your Thursday evening trip" }), null],
  ["sign-in notice", m({ from: "account-noreply@example.net", subject: "New sign-in to your account" }), null],
  ["bank scam-tips marketing", m({ from: "Big Bank <onlinebanking@bank.example.com>", subject: "Alex, do you know about these 4 scams?", text: "Want to see the online version of this email from Bank of America? Click here", primary: true, important: true }), null],
  ["bank marketing from a bare institution domain", m({ from: "offers@" + "fidelity.com" /* a public brokerage on the built-in list */, subject: "Alex, your rollover options today", primary: true, important: true }), null],
  ["bank payment problem still counts", m({ from: "alerts@bank.example.com", subject: "Your payment was declined", important: true }), "urgent"],
  ["his own sent mail", m({ from: "alex@example.com", subject: "Re: catering order today", primary: true, important: true }), null],
];
for (const [name, msg, want] of cases) {
  await check("rules: " + name, () => {
    const got = gs.classify(msg, cfg);
    assert.equal(got ? "urgent" : null, want, name + " -> " + JSON.stringify(got));
  });
}
await check("rules: the weak 'asks for something' guess is quiet", () => {
  const got = gs.classify(m({ from: "someone@example.org", subject: "Quick call tomorrow?", primary: true }), cfg);
  assert.match(got, /unconfirmed/);
});
await check("rules: blocked sender is trashed, never raised", () => {
  assert.equal(gs.isBlocked(m({ from: "Pushy Seller <pushy@example.net>" }), cfg), true);
  assert.equal(gs.classify(m({ from: "pushy@example.net", subject: "sign today" }), cfg), null);
});
await check("rules: sender address is read out of a display name", () => {
  assert.deepEqual(gs.address("Dan Costa <a1b2@convo.homes.example.com>"), { email: "a1b2@convo.homes.example.com", name: "Dan Costa" });
  assert.deepEqual(gs.address("plain@example.com"), { email: "plain@example.com", name: "" });
});
await check("sorting: live filing trashes Trash and archives every other label", () => {
  assert.deepEqual(gs.file_([{ thread_id: "t1", label: "Trash" }, { thread_id: "t2", label: "Housing" }]), [
    { id: null, thread: "t1", add: [], remove: [], trash: true },
    { id: null, thread: "t2", add: ["Housing"], remove: ["INBOX"], trash: false },
  ]);
});

// ---- which new rows push to the phone ----
const sort = await import("./mail-sort.ts");
const row = (reason) => ({ title: "x", body: "y", msg_id: "1", reason });
await check("push: replies always push, without asking the model", async () => {
  const calls = [];
  const rpc = async (n) => { calls.push(n); return null; };
  const got = await sort.choosePushes(rpc, [row("Reply to your email")], [], 0, new Date("2026-11-09T18:00:00Z"));
  assert.equal(got.length, 1);
  assert.deepEqual(calls, []);
});
await check("push: with no model, only replies and relays push", async () => {
  const rpc = async () => null;
  const got = await sort.choosePushes(rpc, [
    row("Personal mail"), row("Payment or account problem"), row("Asks for something"),
    row("Asks for something (unconfirmed)"), row("Message through homes.example.com"), row("Reply to your email"),
  ], [], 0, new Date("2026-11-09T18:00:00Z"));
  assert.equal(got.length, 2);
  assert.ok(got.every((g) => Object.keys(g).join() === "title,body,tag"));
});

await check("push: in quiet hours replies and relays wait for the morning", async () => {
  const rpc = async () => null;
  const rows = [row("Reply to your email"), row("Payment or account problem"), row("Message through homes.example.com")];
  const night = new Date("2026-11-09T07:30:00Z"); // 11:30pm Pacific
  const day = new Date("2026-11-09T18:00:00Z");   // 10am Pacific
  assert.equal(sort.isQuietHour(night), true);
  assert.equal(sort.isQuietHour(new Date("2026-11-09T15:30:00Z")), false); // 7:30am Pacific
  assert.equal((await sort.choosePushes(rpc, rows, [], 0, night)).length, 0);
  assert.equal((await sort.choosePushes(rpc, rows, [], 0, day)).length, 2); // reply and relay, no model
});

await check("filing: mail on Requires Action stays there, never trashed", () => {
  const got = sort.guardFiling([{ thread_id: "t1", label: "Trash" }, { thread_id: "t2", label: "Money" }], ["t1"]);
  assert.deepEqual(got.map((d) => d.label), ["Requires Action", "Money"]);
  assert.deepEqual(gs.file_([got[0]])[0], { id: null, thread: "t1", add: ["Requires Action"], remove: ["INBOX"], trash: false });
});

await check("raise: codes and sign-in notices never reach Requires Action", () => {
  const noise = ["Verification code for your Xfinity account", "New Xfinity sign in", "Your password",
    "Your one-time passcode", "Your account was accessed from a new device", "Sign-in attempt from Chrome",
    "Your Google verification code is 123456", "Was this you?", "Two-step verification turned on"];
  const keep = ["Lockbox Code for Showing Today | 100 Main St 1", "Re: Alex is requesting information about 200 Oak Way",
    "Your Apple Account password has been reset.", "You've made a change to your Xfinity account",
    "Showing Confirmed | 100 Main St 1", "Update • Invoice #ABC123XYZ is 30 days overdue"];
  for (const s of noise) assert.equal(sort.isSecurityNoise({ subject: s, reason: "Personal mail" }), true, s);
  for (const s of keep) assert.equal(sort.isSecurityNoise({ subject: s, reason: "Personal mail" }), false, s);
  assert.equal(sort.isSecurityNoise({ subject: "New sign-in, account locked", reason: "Payment or account problem" }), false);
  assert.equal(sort.isSecurityNoise({ subject: "Re: your code", reason: "Reply to your email" }), false);
});

console.log("\n" + passed + " checks passed");
