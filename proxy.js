'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const qs = require('querystring');

const app = express();
const PORT = process.env.PORT || 3030;

app.use(cors());
app.use(express.json());

/* ── Constants ── */
const SAP_HOST = 'fioriappslibrary.hana.ondemand.com';
const IDP_HOST = 'accounts.sap.com';
const SINGLE_BASE = '/sap/fix/externalViewer/services/SingleApp.xsodata';
const RELEASES_URL = `https://${SAP_HOST}${SINGLE_BASE}/Releases?$format=json&$select=releaseId,releaseName,externalName,releaseType,releaseRank&$orderby=releaseRank%20desc`;
const REQUEST_TIMEOUT_MS = 30_000;

/* ── Session State ── */
let sessionCookies = '';
let sessionExpiry = 0;
let releasesCache = null;

/* ── HTTPS Helpers ── */
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

function parseCookieJar(existing, setCookieHeaders) {
  const map = existing instanceof Map ? new Map(existing) : new Map();
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders].filter(Boolean);
  for (const h of headers) {
    const nameVal = h.split(';')[0].trim();
    const eq = nameVal.indexOf('=');
    if (eq > 0) {
      map.set(nameVal.slice(0, eq).trim(), nameVal.slice(eq + 1).trim());
    }
  }
  return map;
}

function jarToHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function htmlDecode(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractAllHiddenFields(html) {
  const fields = {};
  const formStart = html.indexOf('id="logOnForm"');
  const formEnd = html.indexOf('</form>', formStart > 0 ? formStart : 0);
  const formHtml = formStart > 0 && formEnd > formStart ? html.slice(formStart, formEnd) : html;
  const inputRe = /<input[^>]+type=["']hidden["'][^>]*>/gi;
  let m;
  while ((m = inputRe.exec(formHtml)) !== null) {
    const tag = m[0];
    const nameM = /name=["']([^"']+)["']/i.exec(tag);
    const valueM = /value=["']([^"']*)["']/i.exec(tag);
    if (nameM) fields[nameM[1]] = valueM ? htmlDecode(valueM[1]) : '';
  }
  return fields;
}

function extractField(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let m = new RegExp(`name=["']${escaped}["'][^>]*value=["']([^"']*)["']`, 'i').exec(html);
  if (m) return htmlDecode(m[1]);
  m = new RegExp(`value=["']([^"']*)"[^>]*name=["']${escaped}["']`, 'i').exec(html);
  if (m) return htmlDecode(m[1]);
  return null;
}

function extractFormAction(html) {
  const m = /id=["']logOnForm["'][^>]*action=["']([^"']+)["']/i.exec(html)
         ?? /action=["']([^"']+)["'][^>]*id=["']logOnForm["']/i.exec(html)
         ?? /action=["']([^"']+)["']/i.exec(html);
  return m ? m[1] : null;
}

/* ── SAML Login Flow ── */
async function doLogin(username, password) {
  let res = await httpsGet(`https://${SAP_HOST}/sap/fix/externalViewer/FitAnalysis/dummy.html`, '');
  let sapJar = parseCookieJar(null, res.headers['set-cookie']);
  let idpJar = new Map();

  const idpRedirect = res.headers['location'];
  if (!idpRedirect) throw new Error('Expected redirect to accounts.sap.com but got none.');

  res = await httpsGet(idpRedirect, '');
  idpJar = parseCookieJar(idpJar, res.headers['set-cookie']);
  if (res.status !== 200) throw new Error(`IDP login page returned status ${res.status}`);

  const hiddenFields = extractAllHiddenFields(res.body);
  const xsrfToken = hiddenFields['xsrfProtection'] ?? '';
  const rawAction = extractFormAction(res.body) ?? '/saml2/idp/sso';
  const decodedAction = rawAction.replace(/&amp;/g, '&');
  const actionUrl = decodedAction.startsWith('http') ? decodedAction : `https://${IDP_HOST}${decodedAction}`;

  const credBody = qs.stringify({ ...hiddenFields, j_username: username, j_password: password });

  res = await httpsPost(actionUrl, credBody, jarToHeader(idpJar), {
    'Referer': idpRedirect,
    'Origin': `https://${IDP_HOST}`,
    'X-CSRF-Token': xsrfToken,
  });
  idpJar = parseCookieJar(idpJar, res.headers['set-cookie']);

  let location = res.headers['location'];
  let attempts = 0;
  while (attempts < 12) {
    attempts++;
    if (res.body && res.body.includes('SAMLResponse')) {
      const samlResp = extractField(res.body, 'SAMLResponse') ?? '';
      const relayState = extractField(res.body, 'RelayState') ?? '';
      const rawAcs = extractFormAction(res.body) ?? `https://${SAP_HOST}/sap/saml2/sp/acs/100`;
      const acsUrl = rawAcs.replace(/&amp;/g, '&').startsWith('http') ? rawAcs.replace(/&amp;/g, '&') : `https://${SAP_HOST}${rawAcs.replace(/&amp;/g, '&')}`;
      res = await httpsPost(acsUrl, qs.stringify({ SAMLResponse: samlResp, RelayState: relayState }), jarToHeader(sapJar));
      sapJar = parseCookieJar(sapJar, res.headers['set-cookie']);
      location = res.headers['location'];
    } else if (location) {
      const absolute = location.startsWith('http') ? location : `https://${SAP_HOST}${location}`;
      const host = new URL(absolute).hostname;
      const jar = host === IDP_HOST ? idpJar : sapJar;
      res = await httpsGet(absolute, jarToHeader(jar));
      if (host === IDP_HOST) idpJar = parseCookieJar(idpJar, res.headers['set-cookie']);
      else sapJar = parseCookieJar(sapJar, res.headers['set-cookie']);
      location = res.headers['location'];
    } else {
      break;
    }
    if (res.status === 200 && !location) break;
  }

  if (sapJar.size === 0) throw new Error('Login failed — no SAP session cookies received.');

  sessionCookies = jarToHeader(sapJar);
  sessionExpiry = Date.now() + 60 * 60 * 1000;
  return { ok: true };
}

/* ── Fetch Details & Target Mappings ── */
async function fetchTargetMappings(appId, releaseId, cookies, prefetchedDetails) {
  const enc = encodeURIComponent(appId);
  const detailsKey = `Details(fioriId='${enc}',releaseId='${releaseId}',inpLanguage='EN',inpfioriId='${enc}',inpreleaseId='${releaseId}')`;
  const base = `https://${SAP_HOST}${SINGLE_BASE}`;

  let details = prefetchedDetails;
  if (!details) {
    const detailsResp = await httpsGet(`${base}/${detailsKey}?$format=json`, cookies);
    if (detailsResp.status === 404) return [];
    if (detailsResp.status === 401 || detailsResp.status === 403) {
      throw new Error(`Authentication error (HTTP ${detailsResp.status}) — session expired.`);
    }
    details = JSON.parse(detailsResp.body).d ?? {};
  }
  const appName = details.AppName ?? details.Title ?? appId;

  const intentsResp = await httpsGet(`${base}/${detailsKey}/SplitAdditionalIntents?$format=json`, cookies);
  const intents = intentsResp.status === 200 ? (JSON.parse(intentsResp.body).d?.results ?? []) : [];

  const launchResp = await httpsGet(`${base}/${detailsKey}/SplitApplauncher?$format=json`, cookies);
  const launchers = launchResp.status === 200 ? (JSON.parse(launchResp.body).d?.results ?? []) : [];

  const count = Math.max(intents.length, launchers.length);
  const results = [];
  for (let i = 0; i < count; i++) {
    const intent = intents[i] ?? {};
    const launch = launchers[i] ?? {};
    results.push({
      AppId: appId,
      AppName: appName,
      SemanticObject: intent.SemanticObject ?? '',
      SemanticAction: intent.SemanticAction ?? '',
      MappingSignatureKeyVal: intent.MappingSignatureKeyVal ?? '',
      Title: launch.Title ?? '',
      Subtitle: launch.Subtitle ?? '',
      Information: launch.Information ?? '',
      ApplauncherParams: launch.ApplauncherParams ?? '',
      TitleText: launch.TitleText ?? '',
      SubtitleText: launch.SubtitleText ?? '',
      ApplicationType: details.ApplicationType ?? '',
      UITechnology: details.UITechnology ?? '',
    });
  }
  return results;
}

async function loadReleases() {
  const r = await httpsGet(RELEASES_URL, '');
  if (r.status !== 200) throw new Error(`SAP returned HTTP ${r.status} fetching releases`);
  return JSON.parse(r.body).d?.results ?? [];
}

async function findLatestRelease(appId, releases, cookies) {
  const enc = encodeURIComponent(appId);
  const base = `https://${SAP_HOST}${SINGLE_BASE}`;
  for (const rel of releases) {
    const key = `Details(fioriId='${enc}',releaseId='${rel.releaseId}',inpLanguage='EN',inpfioriId='${enc}',inpreleaseId='${rel.releaseId}')`;
    const resp = await httpsGet(`${base}/${key}?$format=json`, cookies);
    if (resp.status === 200) {
      return { rel, details: JSON.parse(resp.body).d ?? {} };
    }
  }
  return null;
}

/* ── Express Endpoints ── */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'fiori-target-mappings.html'));
});

app.get('/status', (req, res) => {
  const loggedIn = sessionCookies.length > 0 && Date.now() < sessionExpiry;
  res.json({ loggedIn, expiresAt: loggedIn ? new Date(sessionExpiry).toISOString() : null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const result = await doLogin(username, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get('/releases', async (req, res) => {
  try {
    releasesCache = await loadReleases();
    res.json(releasesCache);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/targetmappings', async (req, res) => {
  const appId = req.query.appId?.trim().toUpperCase();
  const releaseId = req.query.releaseId?.trim();

  if (!appId) return res.status(400).json({ error: 'appId parameter is required' });

  const isLoggedIn = sessionCookies.length > 0 && Date.now() < sessionExpiry;
  if (!isLoggedIn) {
    return res.status(401).json({ error: 'Not authenticated. POST /login first.' });
  }

  try {
    const useAuto = !releaseId || releaseId === 'auto';
    if (useAuto) {
      const releases = releasesCache ?? await loadReleases();
      releasesCache = releases;
      const found = await findLatestRelease(appId, releases, sessionCookies);
      if (!found) return res.json({ resolvedRelease: null, tms: [] });

      const tms = await fetchTargetMappings(appId, found.rel.releaseId, sessionCookies, found.details);
      return res.json({ resolvedRelease: found.rel, tms });
    } else {
      const tms = await fetchTargetMappings(appId, releaseId, sessionCookies);
      const relMeta = (releasesCache ?? []).find(r => r.releaseId === releaseId) ?? { releaseId };
      return res.json({ resolvedRelease: relMeta, tms });
    }
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'fiori-target-mappings.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
