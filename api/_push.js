// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) with Node's built-in crypto —
// no extra packages. The VAPID key pair is derived deterministically from a
// secret that is already set in Vercel (VAPID_SEED, else the Anthropic key),
// so no new secret has to be created or pasted anywhere. If that secret
// changes, the public key changes and the app re-subscribes automatically.
const crypto = require("crypto");
const { decide } = require("./_notify");

const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

function seed() {
  return (process.env.VAPID_SEED || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_KEY || "").trim();
}

let cached = null;
function vapidKeys() {
  const s = seed();
  if (!s) return null;
  if (cached && cached.seed === s) return cached;
  const d = crypto.createHmac("sha256", s).update("jeetos-vapid-v1").digest();
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const privateKey = crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
  cached = { seed: s, publicKey: b64u(pub), privateKey };
  return cached;
}

function vapidHeader(endpoint) {
  const k = vapidKeys();
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:jeetos-coach@users.noreply.github.com" }));
  const sig = crypto.sign("sha256", Buffer.from(header + "." + payload), { key: k.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${k.publicKey}`;
}

// RFC 8291 message encryption (aes128gcm content coding, single record).
function encrypt(sub, text) {
  const uaPublic = fromB64u(sub.p256dh);
  const authSecret = fromB64u(sub.auth);
  const as = crypto.createECDH("prime256v1");
  as.generateKeys();
  const asPublic = as.getPublicKey();
  const shared = as.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

async function sendPush(sub, data) {
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "normal", Authorization: vapidHeader(sub.endpoint) },
    body: encrypt(sub, JSON.stringify(data)),
  });
  return r.status;
}

const istDay = t => new Date(t + 330 * 60000).toISOString().slice(0, 10);
async function rows(supa, path) {
  try { const r = await supa(path); if (!r || !r.ok) return null; const d = await r.json(); return Array.isArray(d) ? d : null; } catch (_) { return null; }
}
async function logPush(supa, row) {
  try { await supa("jeetos_push_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) }); } catch (_) { }
}

// Sends to every saved device — after the notification budget (api/_notify.js)
// says yes — and drops subscriptions the push service says are gone.
async function sendToAll(supa, data) {
  if (!vapidKeys()) return { sent: 0, error: "no VAPID seed configured" };
  const now = Date.now(), day = istDay(now), tag = String((data && data.tag) || "");
  const [sentToday, settings, focus] = await Promise.all([
    rows(supa, `jeetos_push_log?day=eq.${day}&decision=eq.sent&select=cls,at&limit=50`),
    rows(supa, "jeetos_settings?id=eq.notify&select=data"),
    rows(supa, "jeetos_focus_sessions?status=eq.active&select=ends_at&limit=1"),
  ]);
  const focusUntil = focus && focus[0] ? Date.parse(focus[0].ends_at) : null;
  const d = decide({ tag, now, sentToday, settings: settings && settings[0] && settings[0].data, focusUntil });
  if (!d.ok) {
    await logPush(supa, { day, tag: tag.slice(0, 80), cls: d.cls, decision: "held", reason: d.reason.slice(0, 120) });
    return { sent: 0, held: d.reason };
  }
  let subs = [];
  try { const r = await supa("jeetos_push_subs?select=endpoint,p256dh,auth"); subs = r.ok ? await r.json() : []; } catch (_) { }
  let sent = 0;
  for (const s of subs) {
    try {
      const st = await sendPush(s, data);
      if (st === 404 || st === 410) await supa(`jeetos_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE" });
      else if (st >= 200 && st < 300) { sent++; await supa(`jeetos_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "PATCH", body: JSON.stringify({ last_ok_at: new Date().toISOString() }) }); }
    } catch (_) { }
  }
  if (d.cls !== "test") await logPush(supa, { day, tag: tag.slice(0, 80), cls: d.cls, decision: sent ? "sent" : "held", reason: sent ? null : "no device accepted it" });
  return { sent, devices: subs.length, cls: d.cls };
}

module.exports = { vapidKeys, sendPush, sendToAll, encrypt, b64u, fromB64u };
