/**
 * Moteur générique ByEmreh — Worker Cloudflare (v2)
 * Une instance = un client (D1 + R2 séparés).
 *
 * Public :
 *   GET  /api/bootstrap            config + produits/prestations + articles (1 seule requête)
 *   GET  /api/articles/:slug
 *   POST /api/devis                simulateur -> enregistre + email Resend au pro
 *   POST /api/contact              journalise un message (l'email part via Formspree côté site)
 *   POST /api/track                statistiques anonymes (sans cookie)
 *   POST /api/cal-webhook?key=...  rendez-vous Cal.com (optionnel)
 *   GET  /images/:key
 *
 * Admin (Authorization: Bearer <token>) :
 *   POST /api/admin/login
 *   GET  /api/admin/overview?days=30
 *   GET|POST /api/admin/config
 *   GET|POST|PUT|DELETE /api/admin/prestations[/:id]
 *   GET|POST|PUT|DELETE /api/admin/articles[/:id]
 *   GET|PUT|DELETE /api/admin/devis[/:id]
 *   GET|PUT|DELETE /api/admin/contacts[/:id]
 *   GET /api/admin/rdv
 *   POST /api/admin/upload
 *   POST /api/admin/test-email
 */

const STATUTS_DEVIS = ["nouveau", "en_cours", "gagne", "perdu"];
const STATUTS_CONTACT = ["nouveau", "traite"];
const TRACK_TYPES = ["view", "sim_start", "buy_click", "cal_view", "cta_click"];
const IMG_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

/* ───────────── Utilitaires HTTP ───────────── */
function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}
function json(data, status, env, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(env), ...(extra || {}) },
  });
}
async function readBody(request) {
  try { const t = await request.text(); return t ? JSON.parse(t) : {}; } catch { return {}; }
}
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const emailOk = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function slugify(s) {
  return (s || "").toString().toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "article";
}

/* ───────────── Auth admin : jeton HMAC-SHA256, 12 h ───────────── */
async function hmacKey(secret, usage) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}
async function signToken(secret, payload) {
  const body = btoa(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(body));
  return `${body}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}
async function verifyToken(secret, token) {
  try {
    if (!secret || !token) return false;
    const [body, sigB64] = token.split(".");
    if (!body || !sigB64) return false;
    const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), sig, new TextEncoder().encode(body));
    return ok && JSON.parse(atob(body)).exp > Date.now();
  } catch { return false; }
}
async function requireAdmin(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return verifyToken(env.ADMIN_TOKEN_SECRET, token);
}
// Comparaison à temps constant (via empreintes SHA-256)
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const A = new Uint8Array(x), B = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

/* ───────────── Limitation de débit (D1) ───────────── */
async function rateLimit(env, key, max, windowSec) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT n, ts FROM rate_limits WHERE k = ?").bind(key).first();
  if (!row || now - row.ts > windowSec * 1000) {
    await env.DB.prepare("INSERT INTO rate_limits (k, n, ts) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET n = 1, ts = excluded.ts").bind(key, now).run();
    return true;
  }
  if (row.n >= max) return false;
  await env.DB.prepare("UPDATE rate_limits SET n = n + 1 WHERE k = ?").bind(key).run();
  return true;
}
const ipOf = (request) => request.headers.get("CF-Connecting-IP") || "0";

/* ───────────── Simulateur : configuration + calcul (côté serveur, donc infalsifiable) ───────────── */
function parseSim(raw) {
  let s = {};
  try { s = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {}; } catch { s = {}; }
  const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
  const out = {
    mode: s.mode === "masque" ? "masque" : "affiche",
    unit_label: clean(s.unit_label || "unité(s)", 30),
    unit_price: num(s.unit_price, 20, 0, 1e6),
    qty_min: Math.round(num(s.qty_min, 1, 1, 100000)),
    qty_max: Math.round(num(s.qty_max, 30, 1, 100000)),
    qty_default: 5,
    range_low: num(s.range_low, -10, -90, 0),
    range_high: num(s.range_high, 15, 0, 300),
    options: [],
  };
  if (out.qty_max < out.qty_min) out.qty_max = out.qty_min;
  out.qty_default = Math.round(num(s.qty_default, 5, out.qty_min, out.qty_max));
  const used = new Set();
  (Array.isArray(s.options) ? s.options.slice(0, 12) : []).forEach((o, i) => {
    const label = clean(o && o.label, 80);
    if (!label) return;
    let key = slugify((o && o.key) || label).slice(0, 40) || "opt" + i;
    while (used.has(key)) key += "-" + i;
    used.add(key);
    out.options.push({ key, label, desc: clean(o.desc, 160), price: num(o.price, 0, -1e6, 1e6) });
  });
  return out;
}
const round5 = (x) => Math.round(x / 5) * 5;
function computeEstimate(sim, prest, qty, optionKeys) {
  const unit = prest && prest.prix_base > 0 ? Number(prest.prix_base) : sim.unit_price;
  const q = Math.min(sim.qty_max, Math.max(sim.qty_min, Math.round(Number(qty)) || sim.qty_default));
  const chosen = sim.options.filter((o) => optionKeys.includes(o.key));
  const total = unit * q + chosen.reduce((s, o) => s + o.price, 0);
  const min = round5(Math.max(0, total * (1 + sim.range_low / 100)));
  const max = Math.max(min, round5(total * (1 + sim.range_high / 100)));
  return { qty: q, unit, chosen, total, min, max };
}

/* ───────────── Normalisation des réglages d'intégration ───────────── */
function normalizeFormspree(v) {
  const m = String(v || "").trim().match(/([a-zA-Z0-9]{6,20})\/?$/);
  return m ? m[1] : "";
}
function normalizeCal(v) {
  let s = String(v || "").trim().replace(/^https?:\/\/(www\.)?cal\.com\//i, "").replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
  if (!s) return "";
  if (!s.includes("/")) s += "/sitetest"; // nom d'événement par défaut
  return /^[a-z0-9._-]+(\/[a-z0-9._-]+){1,2}$/i.test(s) ? s : "";
}
const httpsOrEmpty = (v) => { const s = clean(v, 500); return s === "" || /^https:\/\/[^\s]+$/i.test(s) ? s : null; };

/* ───────────── Emails (Resend) ───────────── */
async function sendResend(env, { to, subject, html, text, replyTo }) {
  if (!env.RESEND_API_KEY) return { ok: false, detail: "Clé RESEND_API_KEY absente (wrangler secret put RESEND_API_KEY)." };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.RESEND_FROM || "Devis <onboarding@resend.dev>", to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    const raw = await r.text();
    let data = {}; try { data = JSON.parse(raw); } catch { /* ignore */ }
    if (r.ok) return { ok: true, detail: data.id || "" };
    return { ok: false, detail: `Resend ${r.status} : ${data.message || raw}`.slice(0, 300) };
  } catch (e) { return { ok: false, detail: "Réseau : " + e.message }; }
}

function devisEmail(d, cfg, est, sim) {
  const dateFr = new Date(d.created_at).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full", timeStyle: "short" });
  const accent = /^#[0-9a-f]{6}$/i.test(cfg.couleur_primaire) ? cfg.couleur_primaire : "#FF5A2B";
  const prix = sim.mode === "affiche" ? `${est.min} € – ${est.max} €` : "À chiffrer par vos soins";
  const opts = est.chosen.length ? est.chosen.map((o) => `${o.label} (${o.price >= 0 ? "+" : ""}${o.price} €)`) : ["Aucune"];
  const row = (k, v) => `<tr><td style="padding:8px 0;color:#6B7280;font-size:13px;width:130px;vertical-align:top">${k}</td><td style="padding:8px 0;font-size:14px;color:#181A1F;font-weight:600">${v}</td></tr>`;
  const html = `<div style="background:#F4F5F7;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #E5E7EB">
<div style="background:${accent};padding:18px 24px;color:#fff;font-size:15px;font-weight:700">Nouvelle demande de devis</div>
<div style="padding:24px">
<p style="margin:0 0 4px;font-size:13px;color:#6B7280">${esc(dateFr)}</p>
<h2 style="margin:0 0 18px;font-size:20px;color:#181A1F">${esc(d.nom)} — ${esc(d.prestation)}</h2>
<div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:14px 16px;margin-bottom:18px">
<div style="font-size:12px;color:#6B7280">${sim.mode === "affiche" ? "Estimation affichée au client" : "Prix masqué au client"}</div>
<div style="font-size:24px;font-weight:700;color:#181A1F">${esc(prix)}</div></div>
<table style="width:100%;border-collapse:collapse">
${row("Client", esc(d.nom))}
${row("Email", `<a href="mailto:${esc(d.email)}" style="color:${accent}">${esc(d.email)}</a>`)}
${row("Téléphone", d.tel ? `<a href="tel:${esc(d.tel)}" style="color:${accent}">${esc(d.tel)}</a>` : "—")}
${row("Prestation", esc(d.prestation))}
${row("Quantité", `${est.qty} ${esc(sim.unit_label)}`)}
${row("Options", opts.map(esc).join("<br>"))}
${row("Message", d.message ? esc(d.message).replace(/\n/g, "<br>") : "—")}
</table>
<p style="margin:22px 0 0"><a href="mailto:${esc(d.email)}?subject=${encodeURIComponent("Votre demande de devis — " + cfg.nom_entreprise)}" style="background:${accent};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:700;font-size:14px;display:inline-block">Répondre à ${esc(d.nom)}</a></p>
<p style="margin:18px 0 0;font-size:12px;color:#9CA3AF">Ce devis est aussi enregistré dans votre espace pro, onglet « Devis ». Répondre à cet email écrit directement au client.</p>
</div></div></div>`;
  const text = `Nouvelle demande de devis — ${d.nom}\n${dateFr}\n\nPrestation : ${d.prestation}\nQuantité : ${est.qty} ${sim.unit_label}\nOptions : ${opts.join(", ")}\nEstimation : ${prix}\n\nEmail : ${d.email}\nTéléphone : ${d.tel || "—"}\nMessage : ${d.message || "—"}\n`;
  return { html, text, subject: `Nouveau devis — ${d.nom} — ${d.prestation}${sim.mode === "affiche" ? ` (${est.min}–${est.max} €)` : ""}` };
}

/* ───────────── Données publiques ───────────── */
function publicConfig(cfg) {
  const { pro_email, sim_config, ...pub } = cfg;
  return { ...pub, cal_link: normalizeCal(cfg.cal_link), sim: parseSim(sim_config) };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const segs = pathname.split("/").filter(Boolean);
    const m = request.method;

    if (m === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });

    try {
      /* ── Images (R2) ── */
      if (pathname.startsWith("/images/") && m === "GET") {
        const obj = await env.IMAGES.get(segs.slice(1).join("/"));
        if (!obj) return json({ ok: false, error: "Image introuvable" }, 404, env);
        return new Response(obj.body, {
          headers: { "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", ...corsHeaders(env) },
        });
      }

      /* ── Site public en UNE requête ── */
      if (pathname === "/api/bootstrap" && m === "GET") {
        const [c, p, a] = await env.DB.batch([
          env.DB.prepare("SELECT * FROM config WHERE id = 1"),
          env.DB.prepare("SELECT id, titre, description, prix_affiche, image_url, stripe_url, bouton_label, badge, prix_base FROM prestations WHERE actif = 1 ORDER BY ordre ASC, id ASC"),
          env.DB.prepare("SELECT id, titre, slug, extrait, image_url, date_publication FROM articles WHERE publie = 1 ORDER BY date_publication DESC LIMIT 30"),
        ]);
        return json({ config: publicConfig(c.results[0]), prestations: p.results, articles: a.results }, 200, env, { "Cache-Control": "public, max-age=20, stale-while-revalidate=120" });
      }

      if (segs[0] === "api" && segs[1] === "articles" && segs[2] && m === "GET") {
        const article = await env.DB.prepare("SELECT * FROM articles WHERE slug = ? AND publie = 1").bind(segs[2]).first();
        if (!article) return json({ ok: false, error: "Article introuvable" }, 404, env);
        return json({ article }, 200, env, { "Cache-Control": "public, max-age=60" });
      }

      /* ── Statistiques anonymes ── */
      if (pathname === "/api/track" && m === "POST") {
        const b = await readBody(request);
        const type = clean(b.type, 20);
        if (!TRACK_TYPES.includes(type)) return json({ ok: true }, 200, env);
        if (type === "view" && /bot|crawl|spider|preview|monitor|lighthouse|headless/i.test(request.headers.get("User-Agent") || "")) return json({ ok: true }, 200, env);
        if (!(await rateLimit(env, "tr:" + ipOf(request), 120, 60))) return json({ ok: true }, 200, env);
        const now = Date.now();
        await env.DB.prepare("INSERT INTO events (created_at, jour, type, label) VALUES (?,?,?,?)").bind(new Date(now).toISOString(), isoDay(now), type, clean(b.label, 80)).run();
        if (Math.random() < 0.02) { // ménage occasionnel
          ctx.waitUntil(env.DB.batch([
            env.DB.prepare("DELETE FROM events WHERE jour < ?").bind(isoDay(now - 400 * 86400000)),
            env.DB.prepare("DELETE FROM rate_limits WHERE ts < ?").bind(now - 86400000),
          ]));
        }
        return json({ ok: true }, 200, env);
      }

      /* ── Message de contact (journal ; l'email part via Formspree depuis le site) ── */
      if (pathname === "/api/contact" && m === "POST") {
        const b = await readBody(request);
        if (b.website) return json({ ok: true }, 200, env); // honeypot
        const nom = clean(b.nom, 100), email = clean(b.email, 150), message = clean(b.message, 3000);
        if (!nom || !emailOk(email) || !message) return json({ ok: false, error: "Champs invalides" }, 400, env);
        if (!(await rateLimit(env, "ct:" + ipOf(request), 6, 600))) return json({ ok: false, error: "Trop de tentatives, réessayez dans quelques minutes." }, 429, env);
        await env.DB.prepare("INSERT INTO contacts (created_at, nom, email, tel, prestation_interessee, message) VALUES (?,?,?,?,?,?)")
          .bind(new Date().toISOString(), nom, email, clean(b.tel, 40), clean(b.prestation, 150), message).run();
        return json({ ok: true }, 200, env);
      }

      /* ── Devis du simulateur ── */
      if (pathname === "/api/devis" && m === "POST") {
        const b = await readBody(request);
        if (b.website) return json({ ok: true }, 200, env); // honeypot
        const nom = clean(b.nom, 100), email = clean(b.email, 150);
        if (!nom || !emailOk(email)) return json({ ok: false, error: "Nom et email valides requis" }, 400, env);
        if (!(await rateLimit(env, "dv:" + ipOf(request), 5, 600))) return json({ ok: false, error: "Trop de demandes, réessayez dans quelques minutes." }, 429, env);

        const cfg = await env.DB.prepare("SELECT * FROM config WHERE id = 1").first();
        const sim = parseSim(cfg.sim_config);
        let prest = null;
        if (b.prestation_id) prest = await env.DB.prepare("SELECT * FROM prestations WHERE id = ? AND actif = 1").bind(Number(b.prestation_id) || 0).first();
        const prestTitre = prest ? prest.titre : clean(b.prestation, 150) || "Non précisé";
        const est = computeEstimate(sim, prest, b.quantite, Array.isArray(b.options) ? b.options.map(String) : []);
        const d = {
          created_at: new Date().toISOString(), nom, email, tel: clean(b.tel, 40), prestation: prestTitre,
          message: clean(b.message, 2000),
        };
        const r = await env.DB.prepare(`INSERT INTO devis (created_at, nom, email, tel, prestation, quantite, unite, options_json, estimation_min, estimation_max, mode, message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(d.created_at, d.nom, d.email, d.tel, d.prestation, est.qty, sim.unit_label, JSON.stringify(est.chosen.map((o) => ({ label: o.label, price: o.price }))), est.min, est.max, sim.mode, d.message).run();
        const id = r.meta.last_row_id;

        // Email au professionnel
        const mail = devisEmail(d, cfg, est, sim);
        const res = await sendResend(env, { to: cfg.pro_email, subject: mail.subject, html: mail.html, text: mail.text, replyTo: d.email });
        await env.DB.prepare("UPDATE devis SET email_statut = ?, email_detail = ? WHERE id = ?").bind(res.ok ? "envoye" : "echec", res.detail, id).run();

        return json({ ok: true, id, mode: sim.mode, estimate: sim.mode === "affiche" ? { min: est.min, max: est.max } : null }, 200, env);
      }

      /* ── Webhook Cal.com (rendez-vous) ── */
      if (pathname === "/api/cal-webhook" && m === "POST") {
        if (!env.CAL_WEBHOOK_KEY || !(await safeEqual(url.searchParams.get("key") || "", env.CAL_WEBHOOK_KEY))) return json({ ok: false, error: "Non autorisé" }, 401, env);
        const body = await readBody(request);
        const trig = body.triggerEvent, p = body.payload || {};
        if (!["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED"].includes(trig)) return json({ ok: true }, 200, env);
        const att = (p.attendees && p.attendees[0]) || {};
        const uid = clean(p.uid || p.bookingId || crypto.randomUUID(), 100);
        if (p.rescheduleUid) await env.DB.prepare("UPDATE rdv SET statut = 'annule' WHERE uid = ?").bind(clean(p.rescheduleUid, 100)).run();
        await env.DB.prepare(`INSERT INTO rdv (uid, created_at, debut, fin, titre, nom, email, statut) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(uid) DO UPDATE SET debut = excluded.debut, fin = excluded.fin, titre = excluded.titre, nom = excluded.nom, email = excluded.email, statut = excluded.statut`)
          .bind(uid, new Date().toISOString(), clean(p.startTime, 40), clean(p.endTime, 40), clean(p.title || p.eventTitle, 150), clean(att.name, 100), clean(att.email, 150), trig === "BOOKING_CANCELLED" ? "annule" : "confirme").run();
        return json({ ok: true }, 200, env);
      }

      /* ── Connexion admin ── */
      if (pathname === "/api/admin/login" && m === "POST") {
        if (!(await rateLimit(env, "lg:" + ipOf(request), 8, 900))) return json({ ok: false, error: "Trop d'essais. Patientez 15 minutes." }, 429, env);
        const { password } = await readBody(request);
        if (!env.ADMIN_PASSWORD || !(await safeEqual(String(password || ""), env.ADMIN_PASSWORD))) return json({ ok: false, error: "Code incorrect" }, 401, env);
        const token = await signToken(env.ADMIN_TOKEN_SECRET, { exp: Date.now() + 12 * 3600 * 1000 });
        return json({ ok: true, token }, 200, env);
      }

      /* ══════════════ Routes protégées ══════════════ */
      if (pathname.startsWith("/api/admin/")) {
        if (!(await requireAdmin(request, env))) return json({ ok: false, error: "Non autorisé" }, 401, env);
        const res = segs[2];
        const id = segs[3] ? parseInt(segs[3], 10) : null;
        if (segs[3] && !Number.isInteger(id)) return json({ ok: false, error: "Identifiant invalide" }, 400, env);

        /* Tableau de bord */
        if (res === "overview" && m === "GET") {
          const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
          const now = Date.now();
          const startCur = isoDay(now - (days - 1) * 86400000);
          const startPrev = isoDay(now - (2 * days - 1) * 86400000);
          const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
          const [ev, dv, ct, rd, top, src, newD, newC, cnt, nextRdv, cfgR, stripeN, fails] = await env.DB.batch([
            q("SELECT jour, type, COUNT(*) c FROM events WHERE jour >= ? GROUP BY jour, type", startPrev),
            q("SELECT substr(created_at,1,10) j, COUNT(*) c FROM devis WHERE substr(created_at,1,10) >= ? GROUP BY j", startPrev),
            q("SELECT substr(created_at,1,10) j, COUNT(*) c FROM contacts WHERE substr(created_at,1,10) >= ? GROUP BY j", startPrev),
            q("SELECT substr(created_at,1,10) j, COUNT(*) c FROM rdv WHERE substr(created_at,1,10) >= ? AND statut = 'confirme' GROUP BY j", startPrev),
            q("SELECT label, COUNT(*) c FROM events WHERE type = 'buy_click' AND jour >= ? GROUP BY label ORDER BY c DESC LIMIT 5", startCur),
            q("SELECT label, COUNT(*) c FROM events WHERE type = 'view' AND jour >= ? GROUP BY label ORDER BY c DESC LIMIT 5", startCur),
            q("SELECT id, created_at, nom, prestation, estimation_min, estimation_max, mode FROM devis WHERE statut = 'nouveau' ORDER BY created_at DESC LIMIT 5"),
            q("SELECT id, created_at, nom, message FROM contacts WHERE statut = 'nouveau' ORDER BY created_at DESC LIMIT 5"),
            q("SELECT (SELECT COUNT(*) FROM devis WHERE statut='nouveau') d, (SELECT COUNT(*) FROM contacts WHERE statut='nouveau') c"),
            q("SELECT * FROM rdv WHERE statut = 'confirme' AND debut >= ? ORDER BY debut ASC LIMIT 5", new Date(now).toISOString()),
            q("SELECT pro_email, formspree_id, cal_link FROM config WHERE id = 1"),
            q("SELECT COUNT(*) n FROM prestations WHERE stripe_url != '' AND actif = 1"),
            q("SELECT COUNT(*) n FROM devis WHERE email_statut = 'echec' AND created_at >= ?", new Date(now - 30 * 86400000).toISOString()),
          ]);

          const labels = [], idx = {};
          for (let i = days - 1; i >= 0; i--) { const j = isoDay(now - i * 86400000); idx[j] = labels.length; labels.push(j); }
          const mk = () => new Array(days).fill(0);
          const series = { visites: mk(), devis: mk(), messages: mk() };
          const cur = { visites: 0, sim_start: 0, achats: 0, devis: 0, messages: 0, rdv: 0 };
          const prev = { visites: 0, sim_start: 0, achats: 0, devis: 0, messages: 0, rdv: 0 };
          const put = (key, j, c, serie) => {
            if (j >= startCur) { cur[key] += c; if (serie && idx[j] !== undefined) series[serie][idx[j]] += c; } else prev[key] += c;
          };
          ev.results.forEach((r) => {
            if (r.type === "view") put("visites", r.jour, r.c, "visites");
            else if (r.type === "sim_start") put("sim_start", r.jour, r.c);
            else if (r.type === "buy_click") put("achats", r.jour, r.c);
          });
          dv.results.forEach((r) => put("devis", r.j, r.c, "devis"));
          ct.results.forEach((r) => put("messages", r.j, r.c, "messages"));
          rd.results.forEach((r) => put("rdv", r.j, r.c));
          const c0 = cfgR.results[0];
          return json({
            ok: true, days, labels, series, cur, prev,
            top_produits: top.results, sources: src.results,
            a_traiter: { devis: newD.results, contacts: newC.results, nb_devis: cnt.results[0].d, nb_contacts: cnt.results[0].c },
            rdv_a_venir: nextRdv.results,
            setup: {
              resend_key: !!env.RESEND_API_KEY, resend_from_test: /onboarding@resend\.dev/i.test(env.RESEND_FROM || "onboarding@resend.dev"),
              pro_email: !!c0.pro_email && !/votre-entreprise/.test(c0.pro_email), formspree: !!c0.formspree_id, cal: !!normalizeCal(c0.cal_link),
              cal_webhook: !!env.CAL_WEBHOOK_KEY, stripe_produits: stripeN.results[0].n, emails_en_echec: fails.results[0].n,
            },
          }, 200, env);
        }

        /* Réglages */
        if (res === "config" && m === "GET") {
          const cfg = await env.DB.prepare("SELECT * FROM config WHERE id = 1").first();
          const { sim_config, ...rest } = cfg;
          return json({ ok: true, config: { ...rest, sim: parseSim(sim_config) } }, 200, env);
        }
        if (res === "config" && m === "POST") {
          const c = await readBody(request);
          const pro = clean(c.pro_email || c.email_contact, 150);
          if (!emailOk(pro)) return json({ ok: false, error: "Email de réception invalide" }, 400, env);
          const color = /^#[0-9a-f]{6}$/i.test(c.couleur_primaire || "") ? c.couleur_primaire : "#FF5A2B";
          const sim = parseSim(c.sim);
          await env.DB.prepare(`UPDATE config SET nom_entreprise=?, tagline=?, description=?, couleur_primaire=?, logo_url=?, email_contact=?, telephone=?, adresse=?, pro_email=?, formspree_id=?, cal_link=?, sim_config=? WHERE id=1`)
            .bind(clean(c.nom_entreprise, 80) || "Votre Entreprise", clean(c.tagline, 200), clean(c.description, 600), color, clean(c.logo_url, 300), clean(c.email_contact, 150), clean(c.telephone, 40), clean(c.adresse, 200), pro, normalizeFormspree(c.formspree_id), normalizeCal(c.cal_link), JSON.stringify(sim)).run();
          return json({ ok: true, cal_link: normalizeCal(c.cal_link), formspree_id: normalizeFormspree(c.formspree_id) }, 200, env);
        }

        /* Test d'envoi d'email */
        if (res === "test-email" && m === "POST") {
          const cfg = await env.DB.prepare("SELECT pro_email, nom_entreprise FROM config WHERE id = 1").first();
          const r = await sendResend(env, {
            to: cfg.pro_email, subject: `Test d'envoi — ${cfg.nom_entreprise}`,
            html: `<div style="font-family:Arial,sans-serif;padding:20px"><h2 style="margin:0 0 8px">✅ L'envoi d'emails fonctionne</h2><p style="color:#555">Vous recevrez vos demandes de devis à cette adresse.</p></div>`,
            text: "L'envoi d'emails fonctionne. Vous recevrez vos demandes de devis à cette adresse.",
          });
          let hint = "";
          if (!r.ok && /403|testing|own email|verify/i.test(r.detail)) hint = "Avec l'expéditeur de test onboarding@resend.dev, Resend n'envoie qu'à l'email de votre compte Resend. Utilisez cet email comme « email de réception », ou vérifiez un domaine dans Resend puis changez RESEND_FROM.";
          else if (!r.ok && /401|API key/i.test(r.detail)) hint = "La clé API Resend est refusée : recréez-en une et relancez « wrangler secret put RESEND_API_KEY ».";
          return json({ ok: r.ok, to: cfg.pro_email, detail: r.detail, hint }, 200, env);
        }

        /* Produits & prestations */
        if (res === "prestations") {
          if (m === "GET" && !id) {
            const { results } = await env.DB.prepare("SELECT * FROM prestations ORDER BY ordre ASC, id ASC").all();
            return json({ ok: true, prestations: results }, 200, env);
          }
          if ((m === "POST" && !id) || (m === "PUT" && id)) {
            const p = await readBody(request);
            const stripe = httpsOrEmpty(p.stripe_url);
            if (stripe === null) return json({ ok: false, error: "Le lien Stripe doit commencer par https://" }, 400, env);
            if (!clean(p.titre, 120)) return json({ ok: false, error: "Le titre est obligatoire" }, 400, env);
            const pb = p.prix_base === "" || p.prix_base == null ? null : Math.max(0, Number(p.prix_base)) || null;
            const vals = [clean(p.titre, 120), clean(p.description, 800), clean(p.prix_affiche, 60) || "Sur devis", clean(p.image_url, 300), Math.round(Number(p.ordre)) || 0, p.actif ? 1 : 0, stripe, clean(p.bouton_label, 30), clean(p.badge, 24), pb];
            if (m === "POST") {
              const r = await env.DB.prepare(`INSERT INTO prestations (titre, description, prix_affiche, image_url, ordre, actif, stripe_url, bouton_label, badge, prix_base) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(...vals).run();
              return json({ ok: true, id: r.meta.last_row_id }, 200, env);
            }
            await env.DB.prepare(`UPDATE prestations SET titre=?, description=?, prix_affiche=?, image_url=?, ordre=?, actif=?, stripe_url=?, bouton_label=?, badge=?, prix_base=? WHERE id=?`).bind(...vals, id).run();
            return json({ ok: true }, 200, env);
          }
          if (m === "DELETE" && id) { await env.DB.prepare("DELETE FROM prestations WHERE id=?").bind(id).run(); return json({ ok: true }, 200, env); }
        }

        /* Blog */
        if (res === "articles") {
          if (m === "GET" && !id) {
            const { results } = await env.DB.prepare("SELECT * FROM articles ORDER BY date_publication DESC").all();
            return json({ ok: true, articles: results }, 200, env);
          }
          if ((m === "POST" && !id) || (m === "PUT" && id)) {
            const a = await readBody(request);
            if (!clean(a.titre, 160)) return json({ ok: false, error: "Le titre est obligatoire" }, 400, env);
            let slug = slugify(a.slug || a.titre);
            const vals = [clean(a.titre, 160), slug, clean(a.extrait, 400), clean(a.contenu, 20000), clean(a.image_url, 300), a.date_publication || new Date().toISOString(), a.publie ? 1 : 0];
            try {
              if (m === "POST") {
                const r = await env.DB.prepare(`INSERT INTO articles (titre, slug, extrait, contenu, image_url, date_publication, publie) VALUES (?,?,?,?,?,?,?)`).bind(...vals).run();
                return json({ ok: true, id: r.meta.last_row_id, slug }, 200, env);
              }
              await env.DB.prepare(`UPDATE articles SET titre=?, slug=?, extrait=?, contenu=?, image_url=?, date_publication=?, publie=? WHERE id=?`).bind(...vals, id).run();
              return json({ ok: true, slug }, 200, env);
            } catch (e) {
              if (/UNIQUE/i.test(e.message)) return json({ ok: false, error: "Un article porte déjà un titre très proche : modifiez légèrement le titre." }, 400, env);
              throw e;
            }
          }
          if (m === "DELETE" && id) { await env.DB.prepare("DELETE FROM articles WHERE id=?").bind(id).run(); return json({ ok: true }, 200, env); }
        }

        /* Devis */
        if (res === "devis") {
          if (m === "GET" && !id) {
            const { results } = await env.DB.prepare("SELECT * FROM devis ORDER BY created_at DESC LIMIT 500").all();
            return json({ ok: true, devis: results }, 200, env);
          }
          if (m === "PUT" && id) {
            const b = await readBody(request);
            if (!STATUTS_DEVIS.includes(b.statut)) return json({ ok: false, error: "Statut invalide" }, 400, env);
            await env.DB.prepare("UPDATE devis SET statut = ?, note = ? WHERE id = ?").bind(b.statut, clean(b.note, 2000), id).run();
            return json({ ok: true }, 200, env);
          }
          if (m === "DELETE" && id) { await env.DB.prepare("DELETE FROM devis WHERE id=?").bind(id).run(); return json({ ok: true }, 200, env); }
        }

        /* Messages de contact */
        if (res === "contacts") {
          if (m === "GET" && !id) {
            const { results } = await env.DB.prepare("SELECT * FROM contacts ORDER BY created_at DESC LIMIT 500").all();
            return json({ ok: true, contacts: results }, 200, env);
          }
          if (m === "PUT" && id) {
            const b = await readBody(request);
            if (!STATUTS_CONTACT.includes(b.statut)) return json({ ok: false, error: "Statut invalide" }, 400, env);
            await env.DB.prepare("UPDATE contacts SET statut = ? WHERE id = ?").bind(b.statut, id).run();
            return json({ ok: true }, 200, env);
          }
          if (m === "DELETE" && id) { await env.DB.prepare("DELETE FROM contacts WHERE id=?").bind(id).run(); return json({ ok: true }, 200, env); }
        }

        /* Rendez-vous */
        if (res === "rdv" && m === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM rdv ORDER BY debut DESC LIMIT 200").all();
          return json({ ok: true, rdv: results }, 200, env);
        }

        /* Upload d'image vers R2 */
        if (res === "upload" && m === "POST") {
          const form = await request.formData();
          const file = form.get("file");
          if (!file || typeof file === "string") return json({ ok: false, error: "Aucun fichier reçu" }, 400, env);
          const ext = IMG_TYPES[file.type];
          if (!ext) return json({ ok: false, error: "Format non accepté (JPG, PNG, WebP, GIF ou AVIF)" }, 400, env);
          if (file.size > 5 * 1024 * 1024) return json({ ok: false, error: "Image trop lourde (5 Mo maximum)" }, 400, env);
          const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
          await env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
          return json({ ok: true, url: `/images/${key}` }, 200, env);
        }
      }

      return json({ ok: false, error: "Not found" }, 404, env);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500, env);
    }
  },
};
