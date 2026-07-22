/**
 * SIGNAL — Local Node.js Token Server
 * Run with: node server/server.js
 *
 * Reads GEMINI_API_KEY from server/.env (see instructions below).
 * Exposes GET http://localhost:3001/api/token for the frontend.
 *
 * ─── WHERE TO PUT YOUR API KEY ───────────────────────────────────────────
 *
 * Create a file called   server/.env   (already git-ignored) with:
 *
 *   GEMINI_API_KEY=AIza...your_key_here...
 *
 * Never commit that file. The .env.example shows the format.
 * ─────────────────────────────────────────────────────────────────────────
 */

import http   from 'http';
import https  from 'https';
import fs     from 'fs';
import path   from 'path';
import url    from 'url';

// ── Load .env file (no npm packages needed) ───────────────────────────────
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const envPath   = path.join(__dirname, '.env');

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
  console.log('[SIGNAL] Loaded .env from', envPath);
} else {
  console.warn('[SIGNAL] No server/.env found — set GEMINI_API_KEY as an environment variable.');
  console.warn('         Create server/.env with: GEMINI_API_KEY=AIza...');
}

// ── Config ─────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3001;
const GEMINI_MODEL = 'models/gemini-3.1-flash-live-preview'; // Gemini 3 Flash Live — must match geminiLive.js

// TODO: gate this behind real auth before production traffic.
// An open token-minting endpoint is a quota-abuse risk.

// CORS: allow GitHub Pages + any localhost origin for dev
const ALLOWED_ORIGINS = [
  'https://adithyahanuman.github.io',
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

function getAllowedOrigin(origin) {
  if (!origin) return 'http://localhost:3001'; // same-origin fallback
  for (const allowed of ALLOWED_ORIGINS) {
    if (typeof allowed === 'string' && allowed === origin) return origin;
    if (allowed instanceof RegExp && allowed.test(origin)) return origin;
  }
  return null;
}

// ── Rate limiting (in-memory, per IP) ────────────────────────────────────
const rateMap = new Map();
function checkRate(ip) {
  const now   = Date.now();
  const times = (rateMap.get(ip) || []).filter(t => now - t < 60_000);
  if (times.length >= 60) return false; // 60 requests/min for local dev
  times.push(now);
  rateMap.set(ip, times);
  return true;
}

// ── Auth headers ─────────────────────────────────────────────────────────
// Both AQ. and AIza keys are API keys — use x-goog-api-key for all.
function buildAuthHeaders(apiKey) {
  return { 'x-goog-api-key': apiKey };
}


function mintToken(apiKey) {
  return new Promise((resolve, reject) => {
    const expireTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    // Body uses camelCase (proto3 JSON encoding) — snake_case is silently ignored
    const body = JSON.stringify({
      expireTime,
      uses: 1,
      liveConnectConstraints: {
        model:  GEMINI_MODEL,
        config: { responseModalities: ['AUDIO'] },
      },
    });

    const authHeaders = buildAuthHeaders(apiKey);
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path:     '/v1alpha/ephemeral-tokens',
      method:   'POST',
      headers:  {
        ...authHeaders,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON from Google API')); }
        } else {
          reject(new Error(`Google API returned ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const origin       = req.headers['origin'] || '';
  const allowedOrigin = getAllowedOrigin(origin);

  const corsHeaders = {
    'Access-Control-Allow-Origin':  allowedOrigin || '',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);

  if (pathname !== '/api/token') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // Rate limiting
  const clientIp = req.socket.remoteAddress || 'unknown';
  if (!checkRate(clientIp)) {
    res.writeHead(429, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
    return;
  }

  // AQ. keys are the new permanent Google AI Studio format.
  // They are passed directly to the frontend as Bearer tokens.
  // AIza keys need to be exchanged for a short-lived ephemeral token first.
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[SIGNAL] GEMINI_API_KEY is not set — create server/.env');
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server misconfigured: missing API key' }));
    return;
  }

  // AQ. and AIza keys are both permanent API keys.
  // Pass AQ. directly as type:apikey — frontend uses ?key= on the WS URL.
  // AIza keys go through ephemeral token minting for the constrained endpoint.
  if (apiKey.toLowerCase().startsWith('aq.')) {
    const resp = JSON.stringify({ token: apiKey, type: 'apikey' });
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(resp);
    console.log(`[SIGNAL] AQ. key sent to client for ${clientIp}`);
    return;
  }

  // AIza key — mint a single-use ephemeral token
  try {
    const data = await mintToken(apiKey);
    const resp = JSON.stringify({ token: data.name, expireTime: data.expireTime });
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(resp);
    console.log(`[SIGNAL] Ephemeral token minted for ${clientIp}`);
  } catch (err) {
    console.error('[SIGNAL] Token mint failed:', err.message);
    res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Token mint failed: ${err.message}` }));
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   SIGNAL token server running         ║');
  console.log(`  ║   http://localhost:${PORT}/api/token    ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('  ⚠  GEMINI_API_KEY not set!');
    console.error('     Open server/.env and paste your key:');
    console.error('     GEMINI_API_KEY=aq.your_key_here');
    console.error('');
  } else {
    const authMethod = key.toLowerCase().startsWith('aq.') ? 'Bearer token (aq. format)' : 'x-goog-api-key (AIza format)';
    console.log(`  ✓  API key loaded  [${authMethod}]`);
    console.log('  ✓  Ready to mint ephemeral tokens');
    console.log('');
  }
});

