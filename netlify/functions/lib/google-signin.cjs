'use strict';
// "Continue with Google" for customer accounts (Jonah, 15 Nov 2026: "we need a google sign in option").
//
// Standard Google sign-in (OpenID Connect, authorization code flow). Google sends the customer back to
// https://<store host>/store-next/account?code=…&state=…; the page posts the code here and we trade it with Google,
// over TLS and with the client secret, for the customer's verified email. That email signs into, or creates, the
// same customer account a password would, so orders, points and subscriptions are all one account.
//
// The home-screen app: on an iPhone, Google's page can open in a sheet over the app, which keeps its own cookies.
// So the app starts with a private random code (nonce) only it knows. Whichever window Google returns to finishes
// the sign-in; if that wasn't the app, the app trades its nonce for a session when it comes back ("claim"). A claim
// works once, within 10 minutes, and only from the same internet connection that started it, so a sign-in link
// someone else started can't be used to take over an account.
//
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the server environment. Without them the button is hidden.
const crypto = require('node:crypto');
const {transaction} = require('./store-db.cjs');
const accounts = require('./customer-accounts.cjs');
const brands = require('./brands.cjs');

const now = () => Math.floor(Date.now() / 1000);
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const TTL = 600;
const COL = 'google_logins';

function configured() { return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET); }
function clientIp(h) { return String(h['x-nf-client-connection-ip'] || h['x-forwarded-for'] || h['x-real-ip'] || 'local').split(',')[0].trim(); }
function same(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
// Google only returns to an address registered on the OAuth client, so it must be one of the Glow store's own hosts.
function redirectUri(h) {
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
  if (process.env.STORE_LOCAL && /^(127\.0\.0\.1|localhost)$/.test(host)) return 'http://' + (h['x-forwarded-host'] || h.host) + '/store-next/account';
  const glow = brands.BRANDS.glow.hosts;
  const base = glow.includes(host) ? 'https://' + host : String(process.env.STORE_ORIGIN || 'https://glowglps.com').replace(/\/$/, '');
  return base + '/store-next/account';
}
function safeBack(v) { return /^\/store-next\/[\w\-./?=&#]*$/.test(String(v || '')) && !/^\/store-next\/(admin|packing|live)/.test(v) ? v : '/store-next/account'; }
function readState(state) {
  const m = String(state || '').match(/^([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/);
  if (!m) fail('This Google sign-in link is not valid. Please try again.');
  return {id: m[1], secret: m[2]};
}

async function start(body, h) {
  if (!configured()) fail('Google sign-in is not turned on yet.', 503);
  if (brands.fromHeaders(h).id !== 'glow') fail('Google sign-in is not available on this store.', 404);
  const nonce = String(body.nonce || '');
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(nonce)) fail('Please try again.');
  await accounts.rate('google-start', clientIp(h), 30, 900);
  const id = crypto.randomBytes(16).toString('hex'), secret = crypto.randomBytes(32).toString('base64url'), redirect = redirectUri(h);
  await transaction(async s => {
    await s.put(COL, id, {id, secret_hash: sha(secret), nonce_hash: sha(nonce), ip: clientIp(h), redirect, back: safeBack(body.back), app: body.app === true, created: now()});
  });
  const q = new URLSearchParams({client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile', state: id + '.' + secret, nonce: sha('oidc:' + secret).slice(0, 43), prompt: 'select_account'});
  return {id, url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q};
}

// Trades the one-time code for Google's ID token. It comes straight from Google over TLS with our client secret,
// so (per OpenID Connect Core 3.1.3.7) its claims are checked rather than its signature.
async function exchange(code, redirect, fetchImpl) {
  let r;
  try {
    r = await fetchImpl('https://oauth2.googleapis.com/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code'}).toString()});
  } catch { fail('Google could not be reached. Please try again.', 502); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || typeof j.id_token !== 'string') fail('Google sign-in did not finish. Please try again.', 400);
  let claims;
  try { claims = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString()); } catch { fail('Google sign-in did not finish. Please try again.'); }
  return claims;
}
function checkClaims(c, secret) {
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(c.iss)) fail('Google sign-in did not finish. Please try again.');
  if ((Array.isArray(c.aud) ? !c.aud.includes(process.env.GOOGLE_CLIENT_ID) : c.aud !== process.env.GOOGLE_CLIENT_ID)) fail('Google sign-in did not finish. Please try again.');
  if (!(c.exp > now() - 60)) fail('Google sign-in expired. Please try again.');
  if (c.nonce !== sha('oidc:' + secret).slice(0, 43)) fail('Google sign-in did not finish. Please try again.');
  if (c.email_verified !== true && c.email_verified !== 'true') fail('Your Google account’s email isn’t verified yet. Verify it with Google, or create an account with your email instead.');
  if (typeof c.sub !== 'string' || !c.sub) fail('Google sign-in did not finish. Please try again.');
  return {sub: c.sub, email: accounts.email(c.email), name: String(c.name || [c.given_name, c.family_name].filter(Boolean).join(' ') || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120)};
}
// Same customer record a password sign-up makes (keyed by email). Google has proven the email, so the account is verified.
async function upsertCustomer(s, g) {
  const id = accounts.hash(g.email);
  let a = await s.get('customers', id);
  if (!a) a = {id, email: g.email, name: g.name, created: now(), verified: false, auth_version: 0, password: null, signup: {via: 'google', at: now()}};
  if (a.google?.sub && a.google.sub !== g.sub) fail('This email is already linked to a different Google account. Sign in with your password instead.', 409);
  if (!a.verified) { a.verified = true; a.verified_at = a.verified_at || now(); a.auth_version = (a.auth_version || 0) + 1; delete a.setup; }
  if (!a.name && g.name) a.name = g.name;
  a.google = {sub: g.sub, linked: a.google?.linked || now(), last: now()};
  await s.put('customers', id, a);
  return a;
}

async function finish(body, h, fetchImpl = fetch) {
  if (!configured()) fail('Google sign-in is not turned on yet.', 503);
  const {id, secret} = readState(body.state), code = String(body.code || '');
  if (!code || code.length > 512) fail('Google sign-in did not finish. Please try again.');
  await accounts.rate('google-finish', clientIp(h), 30, 900);
  // Mark the attempt used before talking to Google, so a code can't be replayed twice.
  const rec = await transaction(async s => {
    const r = await s.get(COL, id);
    if (!r || !same(r.secret_hash, sha(secret)) || r.created < now() - TTL) fail('This Google sign-in expired. Please try again.', 403);
    if (r.used) fail('This Google sign-in was already used. Please try again.', 409);
    r.used = now(); await s.put(COL, id, r); return r;
  });
  const g = checkClaims(await exchange(code, rec.redirect, fetchImpl), secret);
  return transaction(async s => {
    const a = await upsertCustomer(s, g), r = await s.get(COL, id);
    r.done = now(); r.customer_id = a.id; r.auth_version = a.auth_version;
    // The window that started this (it holds the nonce) is signed in now; nothing is left to claim.
    if (body.nonce && same(r.nonce_hash, sha(body.nonce))) r.claimed = now();
    await s.put(COL, id, r);
    return {status: 200, headers: {'Set-Cookie': await accounts.newSession(s, a)}, body: {...await accounts.accountData(s, a, require('./brands.cjs').fromHeaders(h).id), back: r.back}};
  });
}

async function claim(body, h) {
  const id = String(body.id || ''), nonce = String(body.nonce || '');
  if (!/^[a-f0-9]{32}$/.test(id) || !/^[A-Za-z0-9_-]{32,64}$/.test(nonce)) fail('Nothing to finish.', 404);
  await accounts.rate('google-claim', clientIp(h), 60, 900);
  return transaction(async s => {
    const r = await s.get(COL, id);
    if (!r || !same(r.nonce_hash, sha(nonce)) || r.created < now() - TTL) fail('Nothing to finish.', 404);
    if (!r.done) return {status: 200, headers: {}, body: {waiting: true}};
    if (r.claimed) fail('Already signed in.', 409);
    if (r.ip !== clientIp(h)) fail('Please sign in with Google again on this phone.', 403);
    const a = await s.get('customers', r.customer_id);
    if (!a?.verified || a.auth_version !== r.auth_version) fail('Please sign in again.', 403);
    r.claimed = now(); await s.put(COL, id, r);
    return {status: 200, headers: {'Set-Cookie': await accounts.newSession(s, a)}, body: {...await accounts.accountData(s, a, require('./brands.cjs').fromHeaders(h).id), back: r.back}};
  });
}

// Old attempts are removed after a day.
async function prune() { await transaction(async s => { for (const r of await s.list(COL)) if (r.created < now() - 86400) await s.remove(COL, r.id); }); }

async function route(path, body, h) {
  if (path === '/account/google/start') return {status: 200, headers: {}, body: await start(body, h)};
  if (path === '/account/google/finish') { const out = await finish(body, h); prune().catch(() => {}); return out; }
  if (path === '/account/google/claim') return claim(body, h);
  return null;
}

module.exports = {configured, route, start, finish, claim, redirectUri, checkClaims, upsertCustomer};
