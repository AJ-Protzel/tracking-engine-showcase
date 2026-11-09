// Web Push with nothing but WebCrypto: payload encryption (RFC 8291,
// aes128gcm) and the VAPID signature (RFC 8292). No library, so nothing to
// pin or audit; checked against RFC 8291's own worked example by
// sweeps/mail-watch.test.mjs.

const enc = new TextEncoder();

export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(str: string): Uint8Array {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

// A P-256 key as JWK, from its raw public point and, for a private key, d.
function jwk(publicRaw: Uint8Array, d?: string): JsonWebKey {
  const k: JsonWebKey = {
    kty: "EC", crv: "P-256", ext: true,
    x: b64u(publicRaw.slice(1, 33)), y: b64u(publicRaw.slice(33, 65)),
  };
  if (d) k.d = d;
  return k;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

// The ephemeral key and salt are random on every message; a test passes fixed
// ones to reproduce the RFC's example.
export async function encrypt(
  payload: Uint8Array, p256dh: string, auth: string,
  fixed?: { asPublic: string; asPrivate: string; salt: string },
): Promise<Uint8Array> {
  const uaPublic = unb64u(p256dh);
  let asPublic: Uint8Array, asPrivate: CryptoKey;
  if (fixed) {
    asPublic = unb64u(fixed.asPublic);
    asPrivate = await crypto.subtle.importKey("jwk", jwk(asPublic, fixed.asPrivate),
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" },
      true, ["deriveBits"]) as CryptoKeyPair;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    asPrivate = pair.privateKey;
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic,
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaKey }, asPrivate, 256));

  const ikm = await hkdf(unb64u(auth), shared,
    concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = fixed ? unb64u(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // one record: the payload, then the 0x02 delimiter that marks the last one
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

export async function generateVapid(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" },
    true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64u(raw), privateKey: priv.d as string };
}

// The Authorization header for one push service, valid 12 hours.
export async function vapidAuth(endpoint: string, publicKey: string, privateKey: string,
                                subject: string): Promise<string> {
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const key = await crypto.subtle.importKey("jwk", jwk(unb64u(publicKey), privateKey),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
    key, enc.encode(head + "." + body)));
  return "vapid t=" + head + "." + body + "." + b64u(sig) + ", k=" + publicKey;
}

export type Subscription = { endpoint: string; p256dh: string; auth: string };

// Returns the push service's status: 201 is sent, 404 and 410 mean the
// subscription is gone and should be dropped.
export async function sendPush(sub: Subscription, message: unknown,
                               vapid: { publicKey: string; privateKey: string; subject: string }) {
  const body = await encrypt(enc.encode(JSON.stringify(message)), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(sub.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body,
  });
  await res.body?.cancel();
  return res.status;
}
