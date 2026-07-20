/**
 * SIGNAL — Gemini Live Ephemeral Token Service
 * Cloudflare Worker · GET /api/token
 *
 * Responsibilities:
 *   1. Read GEMINI_API_KEY from Worker secrets (never from code)
 *   2. Call Google's v1alpha token-minting endpoint to create a
 *      single-use ephemeral token constrained to the chosen model
 *      and response modality, so a stolen token can't be repurposed
 *   3. Return { token, expireTime } to the browser
 *   4. Enforce CORS (only adithyahanuman.github.io)
 *   5. Simple in-memory rate limiting (10 req / IP / minute)
 *
 * TODO: gate this behind real auth before production traffic.
 *       An open token-minting endpoint is a quota-abuse risk.
 *       Add JWT/session validation here before removing this comment.
 */

// ── Model selection ────────────────────────────────────────────────────────
// Using gemini-2.5-flash-native-audio (stable as of July 2026).
// Google occasionally releases new native-audio model versions; update this
// string and redeploy the Worker if you see deprecation warnings.
const GEMINI_MODEL = 'models/gemini-2.5-flash-native-audio';

// Token lifetime (separate from the 15-minute session cap).
// Keep short; the browser mints a fresh token per session anyway.
const TOKEN_EXPIRE_MINUTES = 5;

// ── CORS ──────────────────────────────────────────────────────────────────
// Restrict to the GitHub Pages origin only.
// Add 'http://localhost:*' entries here for local dev if needed,
// but never commit '*' as the allowed origin.
const ALLOWED_ORIGINS = new Set([
  'https://adithyahanuman.github.io',
  // 'http://localhost:8080',  // uncomment for local dev testing
]);

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

// ── In-memory rate limiter ─────────────────────────────────────────────────
// Simple sliding-window counter keyed by IP.
// Resets on Worker restart (Cloudflare spins Workers down after inactivity),
// so this is a best-effort defence. For stronger protection, use a KV store.
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX       = 10;     // requests per window per IP

const rateLimitMap = new Map(); // ip → [timestamps]

function checkRateLimit(ip) {
  const now   = Date.now();
  const times = (rateLimitMap.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (times.length >= RATE_LIMIT_MAX) return false;
  times.push(now);
  rateLimitMap.set(ip, times);
  return true;
}

// ── Token minting ──────────────────────────────────────────────────────────
async function mintToken(apiKey) {
  const expireTime = new Date(Date.now() + TOKEN_EXPIRE_MINUTES * 60 * 1000).toISOString();

  const body = {
    expire_time: expireTime,
    uses:        1,
    // Constrain the token so it can ONLY be used with this exact
    // model+modality config. A stolen token cannot open a different session.
    live_connect_constraints: {
      model: GEMINI_MODEL,
      config: {
        response_modalities: ['AUDIO'],
      },
    },
  };

  // v1alpha is required for ephemeral token minting — do not change to v1beta.
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1alpha/ephemeral-tokens`,
    {
      method:  'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type':   'application/json',
      },
      body: JSON.stringify(body),
    },
  );

  if (!resp.ok) {
    const errText = await resp.text();
    // Never include apiKey in error messages
    throw new Error(`Token mint failed (${resp.status}): ${errText}`);
  }

  return resp.json(); // { name, expireTime } — name IS the token
}

// ── Main handler ───────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors   = corsHeaders(origin);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Only expose /api/token
    if (url.pathname !== '/api/token') {
      return new Response('Not Found', { status: 404, headers: cors });
    }

    // Method guard
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: cors });
    }

    // Rate limiting
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(clientIp)) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Please wait a moment.' }),
        { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } },
      );
    }

    // API key guard
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('[SIGNAL] GEMINI_API_KEY secret is not set');
      return new Response(
        JSON.stringify({ error: 'Service misconfigured' }),
        { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } },
      );
    }

    // Mint token
    try {
      const data = await mintToken(apiKey);
      // data.name is the ephemeral token value
      return new Response(
        JSON.stringify({ token: data.name, expireTime: data.expire_time }),
        {
          status:  200,
          headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        },
      );
    } catch (err) {
      console.error('[SIGNAL] Token mint error:', err.message);
      return new Response(
        JSON.stringify({ error: 'Failed to mint session token' }),
        { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } },
      );
    }
  },
};
