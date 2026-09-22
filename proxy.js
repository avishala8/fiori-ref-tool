#!/usr/bin/env node
/**
 * Local proxy for the SAP Fiori Apps Reference Library
 * ────────────────────────────────────────────────────
 * Usage:
 *   node proxy.js [port]          (default port: 3030)
 *
 * Endpoints exposed:
 *   GET /releases              → returns available releases as JSON
 *   GET /targetmappings?appId=F0001&releaseId=S27OP
 *                              → returns SAPFioriLaunchpad target mappings as JSON
 *   POST /login  body: { username, password }
 *                              → authenticates with SAP IDP, caches the session cookie
 *   GET /status                → returns { loggedIn: true/false }
 *
 * No npm install required — uses only Node.js built-ins (http, https, url, querystring).
 * Requires Node.js 16+.
 */

'use strict';

const http       = require('http');
const https      = require('https');
const { URL }    = require('url');
const qs         = require('querystring');

const PORT = parseInt(process.argv[2] ?? '3030', 10);

const SAP_HOST      = 'fioriappslibrary.hana.ondemand.com';
const IDP_HOST      = 'accounts.sap.com';
const SINGLE_BASE   = '/sap/fix/externalViewer/services/SingleApp.xsodata';
const RELEASES_URL  = `https://${SAP_HOST}${SINGLE_BASE}/Releases?$format=json&$select=releaseId,releaseName,externalName,releaseType,releaseRank&$orderby=releaseRank%20desc`;

/* ── session state ── */
let sessionCookies = '';   // raw Cookie header value after successful login
let sessionExpiry  = 0;    // epoch ms

/* ── releases cache ── */
let releasesCache  = null; // array of release objects, sorted by releaseRank desc

/* ── helpers ── */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

function json(res, status, obj) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const REQUEST_TIMEOUT_MS = 30_000;  // 30 s per request

function httpsGet(urlStr, cookieHeader) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/html, */*',
        'User-Agent': 'Mozilla/5.0 (SAP Fiori Target Mapping Fetcher)',
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
      },
    };
    const req = https.request(opts, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(new Error(`Request timed out: GET ${urlStr.slice(0, 80)}`)); });
    req.end();
  });
}

function httpsPost(urlStr, postBody, cookieHeader, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const bodyBuf = Buffer.from(postBody);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': bodyBuf.length,
        'User-Agent': 'Mozilla/5.0 (SAP Fiori Target Mapping Fetcher)',
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
        ...(extraHeaders ?? {}),
      },
    };
    const req = https.request(opts, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(new Error(`Request timed out: POST ${urlStr.slice(0, 80)}`)); });
    req.write(bodyBuf);
    req.end();
  });
}

/** Parse Set-Cookie headers into a Cookie jar (Map), merge with existing */
function parseCookieJar(existing, setCookieHeaders) {
  // existing is a Map<name, value>
  const map = existing instanceof Map ? new Map(existing) : new Map();
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders].filter(Boolean);
  for (const h of headers) {
    // Each Set-Cookie: name=value; path=...; secure; ...
    const nameVal = h.split(';')[0].trim();
    const eq = nameVal.indexOf('=');
    if (eq > 0) {
      const k = nameVal.slice(0, eq).trim();
      const v = nameVal.slice(eq + 1).trim();
      map.set(k, v);
    }
  }
  return map;
}

/** Serialise a cookie jar Map into a Cookie header string */
function jarToHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Extract a hidden form field value from HTML (handles any attribute order) */
function extractField(html, name) {
  // Match <input ... name="FIELD" ... value="VALUE" ...> in any attribute order
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // name before value
  let m = new RegExp(`name=["']${escaped}["'][^>]*value=["']([^"']*)["']`, 'i').exec(html);
  if (m) return htmlDecode(m[1]);
  // value before name
  m = new RegExp(`value=["']([^"']*)"[^>]*name=["']${escaped}["']`, 'i').exec(html);
  if (m) return htmlDecode(m[1]);
  // standalone value="" with name= anywhere on same tag — fallback: scan the whole <input> tag
  m = new RegExp(`<input[^>]+name=["']${escaped}["'][^>]*>`, 'i').exec(html);
  if (m) {
    const tagHtml = m[0];
    const v = /value=["']([^"']*)["']/i.exec(tagHtml);
    return v ? htmlDecode(v[1]) : '';
  }
  return null;
}

/** Decode HTML entities in a string (&#x2713; → ✓, &amp; → &, etc.) */
function htmlDecode(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g,      (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Extract ALL hidden field names+values from the logOnForm, HTML-decoding values */
function extractAllHiddenFields(html) {
  const fields = {};
  // Find the logOnForm
  const formStart = html.indexOf('id="logOnForm"');
  const formEnd   = html.indexOf('</form>', formStart > 0 ? formStart : 0);
  const formHtml  = formStart > 0 && formEnd > formStart
    ? html.slice(formStart, formEnd)
    : html;
  // Extract all <input type="hidden" ...> tags
  const inputRe = /<input[^>]+type=["']hidden["'][^>]*>/gi;
  let m;
  while ((m = inputRe.exec(formHtml)) !== null) {
    const tag    = m[0];
    const nameM  = /name=["']([^"']+)["']/i.exec(tag);
    const valueM = /value=["']([^"']*)["']/i.exec(tag);
    // HTML-decode the value so &#x2713; becomes ✓ etc.
    if (nameM) fields[nameM[1]] = valueM ? htmlDecode(valueM[1]) : '';
  }
  return fields;
}

/** Extract form action URL */
function extractFormAction(html) {
  // Find the logOnForm action specifically
  const m = /id=["']logOnForm["'][^>]*action=["']([^"']+)["']/i.exec(html)
         ?? /action=["']([^"']+)["'][^>]*id=["']logOnForm["']/i.exec(html)
         ?? /action=["']([^"']+)["']/i.exec(html);
  return m ? m[1] : null;
}

/* ── login flow ── */
async function doLogin(username, password) {
  console.log('  [auth] Starting SAP IDP login flow…');

  // Step 1: GET dummy.html — triggers 303 redirect to accounts.sap.com SAML SSO
  let res = await httpsGet(
    `https://${SAP_HOST}/sap/fix/externalViewer/FitAnalysis/dummy.html`, ''
  );
  let sapJar = parseCookieJar(null, res.headers['set-cookie']);   // SAP-side cookies
  let idpJar = new Map();                                          // IDP-side cookies

  // Follow 303 redirect to IDP (manual — don't follow automatically so we can track cookies per host)
  const idpRedirect = res.headers['location'];
  if (!idpRedirect) throw new Error('Expected redirect to accounts.sap.com but got none.');
  console.log(`  [auth] → IDP: ${idpRedirect.substring(0, 80)}…`);

  // Step 2: GET the IDP login page
  res = await httpsGet(idpRedirect, '');
  idpJar = parseCookieJar(idpJar, res.headers['set-cookie']);

  if (res.status !== 200) {
    throw new Error(`IDP login page returned status ${res.status}`);
  }
  const loginHtml = res.body;

  // Extract ALL hidden form fields (utf8, authenticity_token, xsrfProtection,
  // SAMLRequest, RelayState, Signature, SigAlg, method, idpSSOEndpoint, spId, etc.)
  const hiddenFields = extractAllHiddenFields(loginHtml);
  const xsrfToken    = hiddenFields['xsrfProtection'] ?? '';
  const authToken    = hiddenFields['authenticity_token'] ?? '';

  // Build the form action URL
  const rawAction = extractFormAction(loginHtml) ?? '/saml2/idp/sso';
  // HTML-decode &amp; in the action attribute
  const decodedAction = rawAction.replace(/&amp;/g, '&');
  const actionUrl = decodedAction.startsWith('http')
    ? decodedAction
    : `https://${IDP_HOST}${decodedAction}`;

  console.log(`  [auth] Form fields found: ${Object.keys(hiddenFields).join(', ')}`);
  console.log(`  [auth] utf8 field value: "${hiddenFields['utf8']}" (codepoint: ${hiddenFields['utf8']?.codePointAt(0)})`);
  console.log(`  [auth] IDP cookies sending: ${[...idpJar.keys()].join(', ')}`);
  console.log(`  [auth] POSTing credentials to ${actionUrl.substring(0, 80)}…`);

  // Step 3: POST credentials — all hidden fields + j_username + j_password
  const credBody = qs.stringify({
    ...hiddenFields,
    j_username: username,
    j_password: password,
  });

  res = await httpsPost(actionUrl, credBody, jarToHeader(idpJar), {
    'Referer': idpRedirect,
    'Origin':  `https://${IDP_HOST}`,
    'X-CSRF-Token': xsrfToken,   // some IDP versions require it in header too
  });
  idpJar = parseCookieJar(idpJar, res.headers['set-cookie']);
  console.log(`  [auth] Credential POST → status ${res.status}, hasSAML=${res.body?.includes('SAMLResponse')}, location=${res.headers['location'] ?? 'none'}`);

  // If the IDP returned an error page (still 200 with form and no SAMLResponse/redirect), report it
  if (res.status === 200 && !res.body.includes('SAMLResponse') && !res.headers['location']) {
    // Extract error message from response
    const errM = /<div[^>]*class="[^"]*(?:error|alert)[^"]*"[^>]*>([\s\S]{0,300})<\/div>/i.exec(res.body)
              ?? /<p[^>]*id="[^"]*error[^"]*"[^>]*>([\s\S]{0,300})<\/p>/i.exec(res.body);
    const errMsg = errM ? errM[1].replace(/<[^>]+>/g, '').trim().slice(0, 200) : 'Unknown error';
    // Also log first 500 chars of response for diagnosis
    console.log(`  [auth] IDP response body (first 500): ${res.body?.slice(0, 500)}`);
    throw new Error(`IDP rejected credentials: ${errMsg}`);
  }

  // Step 4: Follow redirects and POST SAMLResponse back to fioriappslibrary
  let location = res.headers['location'];
  let attempts = 0;
  while (attempts < 12) {
    attempts++;

    if (res.body && res.body.includes('SAMLResponse')) {
      // IDP POST binding: extract SAMLResponse and POST to ACS
      const samlResp  = extractField(res.body, 'SAMLResponse') ?? '';
      const relayState = extractField(res.body, 'RelayState') ?? '';
      const rawAcs    = extractFormAction(res.body) ?? `https://${SAP_HOST}/sap/saml2/sp/acs/100`;
      const decodedAcs = rawAcs.replace(/&amp;/g, '&');
      const acsUrl    = decodedAcs.startsWith('http') ? decodedAcs : `https://${SAP_HOST}${decodedAcs}`;
      console.log(`  [auth] Posting SAMLResponse to ${acsUrl.substring(0, 80)}…`);
      res = await httpsPost(acsUrl, qs.stringify({ SAMLResponse: samlResp, RelayState: relayState }), jarToHeader(sapJar));
      sapJar = parseCookieJar(sapJar, res.headers['set-cookie']);
      location = res.headers['location'];

    } else if (location) {
      const absolute = location.startsWith('http') ? location : `https://${SAP_HOST}${location}`;
      console.log(`  [auth] Redirect → ${absolute.substring(0, 80)}…`);
      const host = new URL(absolute).hostname;
      const jar  = host === IDP_HOST ? idpJar : sapJar;
      res = await httpsGet(absolute, jarToHeader(jar));
      if (host === IDP_HOST) idpJar = parseCookieJar(idpJar, res.headers['set-cookie']);
      else                   sapJar = parseCookieJar(sapJar, res.headers['set-cookie']);
      location = res.headers['location'];

    } else {
      break;  // No more redirects and no SAMLResponse — done
    }

    if (res.status === 200 && !location) break;
  }

  // Verify we have SAP-side session cookies
  if (sapJar.size === 0) {
    throw new Error('Login failed — no SAP session cookies. Check your credentials.');
  }

  // Quick smoke-test: hit a known-authenticated endpoint
  const cookieHeader = jarToHeader(sapJar);
  const verify = await httpsGet(
    `https://${SAP_HOST}${SINGLE_BASE}/Details(fioriId='F2305',releaseId='S37',inpLanguage='EN',inpfioriId='F2305',inpreleaseId='S37')?$format=json`,
    cookieHeader
  );
  console.log(`  [auth] Verification request → status ${verify.status}`);
  if (verify.status !== 200) {
    throw new Error(`Session established but verification request failed (HTTP ${verify.status}). Check credentials or account permissions.`);
  }

  sessionCookies = cookieHeader;
  sessionExpiry  = Date.now() + 60 * 60 * 1000;
  console.log('  [auth] ✓ Login successful. Session cached for 1 hour.');
  return { ok: true };
}

/* ── request body reader ── */
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

/* ── fetch target mappings ── */
// prefetchedDetails can be passed from findLatestRelease to avoid a redundant Details call
async function fetchTargetMappings(appId, releaseId, cookies, prefetchedDetails) {
  const enc = encodeURIComponent(appId);
  // Details entity key: all five fields required (two input params + three output keys)
  const detailsKey = `Details(fioriId='${enc}',releaseId='${releaseId}',inpLanguage='EN',inpfioriId='${enc}',inpreleaseId='${releaseId}')`;
  const base = `https://${SAP_HOST}${SINGLE_BASE}`;

  // 1. Fetch Details (or reuse the one from findLatestRelease)
  let details;
  if (prefetchedDetails) {
    details = prefetchedDetails;
  } else {
    const detailsResp = await httpsGet(`${base}/${detailsKey}?$format=json`, cookies);
    if (detailsResp.status === 404) return [];
    if (detailsResp.status === 401 || detailsResp.status === 403) {
      throw new Error(`Authentication error (HTTP ${detailsResp.status}) — session may have expired, please sign in again`);
    }
    if (detailsResp.status !== 200) {
      throw new Error(`SAP returned HTTP ${detailsResp.status}: ${detailsResp.body.slice(0, 200)}`);
    }
    details = JSON.parse(detailsResp.body).d ?? {};
  }
  const appName = details.AppName ?? details.Title ?? appId;

  // 2. Fetch SplitAdditionalIntents (SemanticObject, SemanticAction, MappingSignatureKeyVal)
  const intentsResp = await httpsGet(`${base}/${detailsKey}/SplitAdditionalIntents?$format=json`, cookies);
  const intents = intentsResp.status === 200
    ? (JSON.parse(intentsResp.body).d?.results ?? [])
    : [];

  // 3. Fetch SplitApplauncher (Title, Subtitle, Information, ApplauncherParams)
  const launchResp = await httpsGet(`${base}/${detailsKey}/SplitApplauncher?$format=json`, cookies);
  const launchers = launchResp.status === 200
    ? (JSON.parse(launchResp.body).d?.results ?? [])
    : [];

  // 4. Merge: each intent row gets matched to the corresponding launcher row by position
  //    (the app always has the same number of target mappings in both entities)
  const count = Math.max(intents.length, launchers.length);
  if (count === 0) return [];

  const results = [];
  for (let i = 0; i < count; i++) {
    const intent  = intents[i]  ?? {};
    const launch  = launchers[i] ?? {};
    results.push({
      AppId:                  appId,
      AppName:                appName,
      SemanticObject:         intent.SemanticObject         ?? '',
      SemanticAction:         intent.SemanticAction         ?? '',
      MappingSignatureKeyVal: intent.MappingSignatureKeyVal ?? '',
      Title:                  launch.Title                  ?? '',
      Subtitle:               launch.Subtitle               ?? '',
      Information:            launch.Information            ?? '',
      ApplauncherParams:      launch.ApplauncherParams      ?? '',
      TitleText:              launch.TitleText              ?? '',
      SubtitleText:           launch.SubtitleText           ?? '',
      // Extra fields from Details
      ApplicationType:        details.ApplicationType       ?? '',
      UITechnology:           details.UITechnology          ?? '',
    });
  }
  return results;
}

/* ── load releases (cached) ── */
async function loadReleases() {
  const r = await httpsGet(RELEASES_URL, '');
  if (r.status !== 200) throw new Error(`SAP returned ${r.status} fetching releases`);
  return JSON.parse(r.body).d?.results ?? [];
}

/**
 * Walk releases from newest → oldest (already sorted by releaseRank desc).
 * Return the first release object where the app exists (HTTP 200 on Details).
 * Returns null if the app is not found in any release.
 */
async function findLatestRelease(appId, releases, cookies) {
  const enc  = encodeURIComponent(appId);
  const base = `https://${SAP_HOST}${SINGLE_BASE}`;
  console.log(`  [auto] Scanning ${releases.length} releases for ${appId}…`);
  for (const rel of releases) {
    // No $select — use the plain Details key exactly as fetchTargetMappings does
    const key  = `Details(fioriId='${enc}',releaseId='${rel.releaseId}',inpLanguage='EN',inpfioriId='${enc}',inpreleaseId='${rel.releaseId}')`;
    const resp = await httpsGet(`${base}/${key}?$format=json`, cookies);
    console.log(`  [auto]   ${rel.releaseId} → HTTP ${resp.status}`);
    if (resp.status === 200) {
      console.log(`  [auto] ${appId} ✓ found in ${rel.releaseId} (${rel.externalName ?? rel.releaseName})`);
      // Parse and return the Details data alongside the release so fetchTargetMappings can skip re-fetching it
      const details = JSON.parse(resp.body).d ?? {};
      return { rel, details };
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Authentication error (HTTP ${resp.status}) — please sign in again`);
    }
    // 404 = app not in this release → try next
  }
  console.log(`  [auto] ${appId} → not found in any release`);
  return null;
}

/* ── server ── */
const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const url   = new URL(req.url, `http://localhost:${PORT}`);
  const path  = url.pathname;
  const query = url.searchParams;

  console.log(`  ${req.method} ${path}`);

  /* ── GET /status ── */
  if (path === '/status' && req.method === 'GET') {
    const loggedIn = sessionCookies.length > 0 && Date.now() < sessionExpiry;
    return json(res, 200, { loggedIn, expiresAt: loggedIn ? new Date(sessionExpiry).toISOString() : null });
  }

  /* ── POST /login ── */
  if (path === '/login' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.username || !body.password) {
        return json(res, 400, { error: 'username and password are required' });
      }
      const result = await doLogin(body.username, body.password);
      return json(res, 200, result);
    } catch (err) {
      console.error('  ✗ Login error:', err.message);
      return json(res, 401, { error: err.message });
    }
  }

  /* ── GET /releases ── */
  if (path === '/releases' && req.method === 'GET') {
    try {
      releasesCache = await loadReleases();
      return json(res, 200, releasesCache);
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  /* ── GET /targetmappings?appId=F0001&releaseId=S27OP (or releaseId=auto) ── */
  if (path === '/targetmappings' && req.method === 'GET') {
    const appId     = query.get('appId')?.trim().toUpperCase();
    const releaseId = query.get('releaseId')?.trim();

    if (!appId) {
      return json(res, 400, { error: 'appId query parameter is required' });
    }

    const isLoggedIn = sessionCookies.length > 0 && Date.now() < sessionExpiry;
    if (!isLoggedIn) {
      return json(res, 401, { error: 'Not authenticated. POST /login first with your SAP credentials.' });
    }

    try {
      const useAuto = !releaseId || releaseId === 'auto';
      if (useAuto) {
        // Auto mode: walk releases newest → oldest, return first hit
        const releases = releasesCache ?? await loadReleases();
        releasesCache  = releases;
        const found = await findLatestRelease(appId, releases, sessionCookies);
        if (!found) {
          // Not found in any release
          return json(res, 200, { resolvedRelease: null, tms: [] });
        }
        // found = { rel, details } — pass pre-fetched details to avoid a second Details call
        const tms = await fetchTargetMappings(appId, found.rel.releaseId, sessionCookies, found.details);
        return json(res, 200, { resolvedRelease: found.rel, tms });
      } else {
        const tms = await fetchTargetMappings(appId, releaseId, sessionCookies);
        // Enrich resolvedRelease with name from cache if available
        const relMeta = (releasesCache ?? []).find(r => r.releaseId === releaseId) ?? { releaseId };
        return json(res, 200, { resolvedRelease: relMeta, tms });
      }
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  json(res, 404, { error: `Unknown endpoint: ${path}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  SAP Fiori Target Mapping — Local Proxy');
  console.log('  ─────────────────────────────────────────');
  console.log(`  Listening on http://127.0.0.1:${PORT}`);
  console.log('');
  console.log('  Endpoints:');
  console.log(`    POST /login          { username, password }  → authenticate`);
  console.log(`    GET  /status                                  → check session`);
  console.log(`    GET  /releases                                → list releases`);
  console.log(`    GET  /targetmappings?appId=F0001&releaseId=S27OP`);
  console.log('');
  console.log('  Now open fiori-target-mappings.html in your browser.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
