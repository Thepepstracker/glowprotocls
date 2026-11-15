'use strict';
// Continue with Google (Jonah, 15 Nov 2026: "we need a google sign in option").
const {test, after} = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glow-google-'));
Object.assign(process.env, {STORE_LOCAL: '1', STORE_SQLITE_PATH: path.join(tmp, 'db.sqlite'), STORE_ADMIN_PASSWORD: 'google-signin-owner-test-password', STORE_SESSION_SECRET: 'google-signin-tests-session-secret-32-chars+', STORE_ORIGIN: 'https://glowglps.com'});
const {transaction} = require('../../netlify/functions/lib/store-db.cjs');
const accounts = require('../../netlify/functions/lib/customer-accounts.cjs');
const g = require('../../netlify/functions/lib/google-signin.cjs');
after(() => fs.rmSync(tmp, {recursive: true, force: true}));

const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const H = (ip = '203.0.113.7') => ({host: 'glowglps.com', 'x-forwarded-for': ip + ', 10.0.0.1'});
const nonce = () => crypto.randomBytes(32).toString('base64url');
const jwt = c => ['e30', Buffer.from(JSON.stringify(c)).toString('base64url'), 'sig'].join('.');
function google(claims) {
  const calls = [];
  const f = async (url, o) => { calls.push({url, body: new URLSearchParams(o.body)}); const secret = calls.at(-1).body.get('code').split(':')[1];
    return {ok: true, json: async () => ({id_token: jwt({iss: 'https://accounts.google.com', aud: 'test-client.apps.googleusercontent.com', exp: Math.floor(Date.now() / 1000) + 3600, nonce: sha('oidc:' + secret).slice(0, 43), email_verified: true, sub: '1001', email: 'Pat.Glow@Example.com', name: 'Pat Glow', ...claims})})}; };
  f.calls = calls; return f;
}
const flow = async (n, h = H()) => { const r = await g.start({nonce: n}, h); const state = new URL(r.url).searchParams.get('state'); return {...r, state, code: 'c:' + state.split('.')[1]}; };

test('hidden until the Google keys are set', async () => {
  assert.equal(g.configured(), false);
  await assert.rejects(g.start({nonce: nonce()}, H()), e => e.status === 503);
  process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com'; process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  assert.equal(g.configured(), true);
});

test('Google sign-in creates one verified account by email, signs in, and can never be replayed', async () => {
  const n = nonce(), f = await flow(n), u = new URL(f.url);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://glowglps.com/store-next/account');
  assert.equal(u.searchParams.get('scope'), 'openid email profile');
  const fetchImpl = google();
  const out = await g.finish({code: f.code, state: f.state, nonce: n}, H(), fetchImpl);
  assert.match(out.headers['Set-Cookie'], /^glow_next_customer=/);
  assert.equal(out.body.customer.email, 'pat.glow@example.com'); assert.equal(out.body.customer.verified, true); assert.equal(out.body.customer.name, 'Pat Glow');
  assert.equal(fetchImpl.calls[0].url, 'https://oauth2.googleapis.com/token'); assert.equal(fetchImpl.calls[0].body.get('client_secret'), 'test-secret');
  const a = await transaction(s => s.get('customers', accounts.hash('pat.glow@example.com')));
  assert.equal(a.google.sub, '1001');
  await assert.rejects(g.finish({code: f.code, state: f.state, nonce: n}, H(), fetchImpl), e => e.status === 409, 'a Google code works once');
  await assert.rejects(g.claim({id: f.id, nonce: n}, H()), e => e.status === 409, 'the window that started it is already signed in');
  // A second Google sign-in later goes into the same account.
  const n2 = nonce(), f2 = await flow(n2); const again = await g.finish({code: f2.code, state: f2.state, nonce: n2}, H(), google());
  assert.equal(again.body.customer.id, a.id);
});

test('the iPhone app finishes a sign-in that ended in Safari: once, only from the same connection', async () => {
  const n = nonce(), f = await flow(n);
  assert.deepEqual((await g.claim({id: f.id, nonce: n}, H())).body, {waiting: true}, 'nothing yet while Google is open');
  await g.finish({code: f.code, state: f.state}, H(), google({sub: '2002', email: 'app.user@example.com'}));
  await assert.rejects(g.claim({id: f.id, nonce: nonce()}, H()), e => e.status === 404, 'wrong code');
  await assert.rejects(g.claim({id: f.id, nonce: n}, H('198.51.100.9')), e => e.status === 403, 'someone else’s connection');
  const c = await g.claim({id: f.id, nonce: n}, H());
  assert.match(c.headers['Set-Cookie'], /^glow_next_customer=/); assert.equal(c.body.customer.email, 'app.user@example.com');
  await assert.rejects(g.claim({id: f.id, nonce: n}, H()), e => e.status === 409, 'only once');
});

test('an account made at checkout (never verified) is verified by Google and keeps its orders', async () => {
  const id = accounts.hash('checkout.buyer@example.com');
  await transaction(s => s.put('customers', id, {id, email: 'checkout.buyer@example.com', name: 'Checkout Buyer', created: 1, verified: false, auth_version: 0, password: null}));
  const n = nonce(), f = await flow(n);
  const out = await g.finish({code: f.code, state: f.state, nonce: n}, H(), google({sub: '3003', email: 'checkout.buyer@example.com', name: 'Other Name'}));
  assert.equal(out.body.customer.id, id); assert.equal(out.body.customer.verified, true); assert.equal(out.body.customer.name, 'Checkout Buyer', 'their name is kept');
});

test('refused: unverified Google email, wrong app, wrong nonce, a different Google account on a linked email', async () => {
  for (const [claims, re] of [[{email_verified: false, sub: '4004', email: 'x1@example.com'}, /isn’t verified/], [{aud: 'someone-else', sub: '4005', email: 'x2@example.com'}, /did not finish/], [{nonce: 'nope', sub: '4006', email: 'x3@example.com'}, /did not finish/], [{sub: '9999', email: 'pat.glow@example.com'}, /different Google account/]]) {
    const n = nonce(), f = await flow(n);
    await assert.rejects(g.finish({code: f.code, state: f.state, nonce: n}, H(), google(claims)), re);
  }
  await assert.rejects(g.finish({code: 'c:x', state: 'bad'}, H(), google()), /not valid/);
  await assert.rejects(g.start({nonce: nonce()}, {host: 'zaderhealth.com'}), e => e.status === 404, 'Glow store only');
  assert.equal(g.redirectUri({host: 'evil.example'}), 'https://glowglps.com/store-next/account', 'never returns to a host we don’t own');
  assert.equal(g.redirectUri({host: 'glowlabprotocols.com'}), 'https://glowlabprotocols.com/store-next/account');
});
