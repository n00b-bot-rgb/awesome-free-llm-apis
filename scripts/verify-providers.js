#!/usr/bin/env node
/**
 * verify-providers.js
 * Daily provider/model verification harness.
 * Usage: node scripts/verify-providers.js --out .verify/report-YYYY-MM-DD.json [--provider "Groq"] [--model "id"]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
};
const outFile = getArg('--out');
const filterProvider = getArg('--provider');
const filterModel = getArg('--model');
const selfTest = args.includes('--self-test');

if (require.main === module && !outFile && !selfTest) {
  console.error('Usage: node scripts/verify-providers.js --out <file> [--provider <name>] [--model <id>]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const ROOT = path.join(__dirname, '..');
const envPath = path.join(ROOT, '.env.verify');
const env = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
}

const KEY = {
  GROQ:        env.GROQ_API_KEY        || process.env.GROQ_API_KEY,
  MISTRAL:     env.MISTRAL_API_KEY     || process.env.MISTRAL_API_KEY,
  CEREBRAS:    env.CEREBRAS_API_KEY    || process.env.CEREBRAS_API_KEY,
  OPENROUTER:  env.OPENROUTER_API_KEY  || process.env.OPENROUTER_API_KEY,
  SAMBANOVA:   env.SAMBANOVA_API_KEY   || process.env.SAMBANOVA_API_KEY,
  SILICONFLOW: env.SILICONFLOW_API_KEY || process.env.SILICONFLOW_API_KEY,
  NVIDIA:      env.NVIDIA_API_KEY      || process.env.NVIDIA_API_KEY,
  HF:          env.HF_API_KEY          || process.env.HF_API_KEY,
  GEMINI:      env.GEMINI_API_KEY      || process.env.GEMINI_API_KEY,
  COHERE:      env.COHERE_API_KEY      || process.env.COHERE_API_KEY,
  CLOUDFLARE:  env.CF_API_TOKEN        || process.env.CF_API_TOKEN,
  CF_ACCOUNT:  env.CF_ACCOUNT_ID       || process.env.CF_ACCOUNT_ID,
  GITHUB:      env.GITHUB_TOKEN        || process.env.GITHUB_TOKEN,
  OLLAMA:      env.OLLAMA_API_KEY      || process.env.OLLAMA_API_KEY,
  AION:        env.AION_API_KEY        || process.env.AION_API_KEY,
  ZAI:         env.ZAI_API_KEY         || process.env.ZAI_API_KEY,
  MODELSCOPE:  env.MODELSCOPE_API_KEY  || process.env.MODELSCOPE_API_KEY,
  KILO:        env.KILO_API_KEY        || process.env.KILO_API_KEY,
  OVH:         env.OVH_API_KEY         || process.env.OVH_API_KEY,
};

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function redactKeys(str) {
  // Redact anything that looks like an API key (long alphanum strings)
  return str.replace(/\b([A-Za-z0-9_\-]{32,})\b/g, '[REDACTED]');
}

function httpRequest(options, body) {
  return new Promise((resolve) => {
    const lib = options.protocol === 'http:' ? http : https;
    const bodyStr = body ? JSON.stringify(body) : null;
    const reqOptions = {
      hostname: options.hostname,
      port: options.port || (options.protocol === 'http:' ? 80 : 443),
      path: options.path,
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...options.headers,
      },
      timeout: 30000,
    };
    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (err) => resolve({ status: 0, body: err.message, error: err }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout', error: new Error('timeout') }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function parseUrl(baseUrl) {
  try { return new URL(baseUrl); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------
function classify(status, bodyStr) {
  const body = bodyStr.toLowerCase();
  if (status === 200) return null;
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 402) return 'BILLING';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'SERVER';
  if (status === 0) return 'NETWORK';
  if (status === 404 || status === 400) {
    if (body.includes('model not found') || body.includes('unknown model') ||
        body.includes('invalid model') || body.includes('does not exist') ||
        body.includes('no such model') || body.includes('model_not_found') ||
        body.includes('model_unavailable') || body.includes('model unavailable') ||
        body.includes('"type":"invalid_request_error"') || body.includes('not supported')) {
      return 'NOT_FOUND';
    }
    if (status === 404) return 'NETWORK';
    return 'SCHEMA';
  }
  if (body.includes('insufficient credits') || body.includes('quota exceeded') ||
      body.includes('out of credits')) return 'BILLING';
  return 'SCHEMA';
}

function verdict(status, bodyStr, parsed) {
  if (status === 200 && parsed) return 'PASS';
  if (status === 200 && !parsed) return 'UNKNOWN';
  const cls = classify(status, bodyStr);
  if (cls === 'AUTH') return 'SKIPPED';
  if (cls === 'RATE_LIMIT' || cls === 'SERVER') return 'UNKNOWN';
  if (cls === 'BILLING' || cls === 'NOT_FOUND' || cls === 'NETWORK') return 'FAIL';
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Validate response has choices[]
// ---------------------------------------------------------------------------
function parseCompletion(bodyStr) {
  try {
    const j = JSON.parse(bodyStr);
    if (typeof j.choices?.[0]?.message?.content === 'string' && j.choices[0].message.content.trim()) return j;
    return null;
  } catch { return null; }
}

function parseCohereResponse(bodyStr) {
  try {
    const j = JSON.parse(bodyStr);
    if (typeof j.message?.content === 'string' && j.message.content.trim()) return j;
    if (Array.isArray(j.message?.content) && j.message.content.some(p => typeof p.text === 'string' && p.text.trim())) return j;
    return null;
  } catch { return null; }
}

function parseOllamaResponse(bodyStr) {
  try {
    const j = JSON.parse(bodyStr);
    if (typeof j.message?.content === 'string' && j.message.content.trim()) return j;
    return null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Provider call implementations
// ---------------------------------------------------------------------------
const STANDARD_BODY = {
  messages: [{ role: 'user', content: 'Say OK' }],
  max_tokens: 8,
};

async function callStandard(baseUrl, modelId, bearerToken) {
  const u = parseUrl(baseUrl);
  if (!u) return { status: 0, body: 'invalid baseUrl', error: new Error('invalid URL') };
  const fullPath = u.pathname.replace(/\/$/, '') + '/chat/completions';
  return httpRequest({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? parseInt(u.port) : undefined,
    path: fullPath,
    headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
  }, { ...STANDARD_BODY, model: modelId });
}

async function callGemini(baseUrl, modelId, apiKey) {
  // OpenAI-compat path is baseUrl + /openai/chat/completions
  const u = parseUrl(baseUrl);
  if (!u) return { status: 0, body: 'invalid baseUrl' };
  const fullPath = u.pathname.replace(/\/$/, '') + '/openai/chat/completions';
  return httpRequest({
    protocol: u.protocol,
    hostname: u.hostname,
    path: fullPath,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  }, { ...STANDARD_BODY, model: modelId });
}

async function callCohere(baseUrl, modelId, apiKey) {
  const u = parseUrl(baseUrl);
  if (!u) return { status: 0, body: 'invalid baseUrl' };
  const fullPath = u.pathname.replace(/\/$/, '') + '/chat';
  return httpRequest({
    protocol: u.protocol,
    hostname: u.hostname,
    path: fullPath,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  }, {
    model: modelId,
    messages: [{ role: 'user', content: 'Say OK' }],
  });
}

async function callCloudflare(baseUrl, modelId, token, accountId) {
  if (!accountId) return { status: 0, body: 'missing CF_ACCOUNT_ID', _skipped: true };
  const resolvedUrl = baseUrl.replace('{account_id}', accountId);
  const u = parseUrl(resolvedUrl);
  if (!u) return { status: 0, body: 'invalid baseUrl' };
  // CF Workers AI uses /run/{model_id}
  const fullPath = u.pathname.replace(/\/$/, '') + '/' + modelId;
  return httpRequest({
    protocol: u.protocol,
    hostname: u.hostname,
    path: fullPath,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }, {
    messages: [{ role: 'user', content: 'Say OK' }],
    max_tokens: 8,
  });
}

async function callOllama(baseUrl, modelId, apiKey) {
  const u = parseUrl(baseUrl);
  if (!u) return { status: 0, body: 'invalid baseUrl' };
  const fullPath = '/api/chat';
  return httpRequest({
    protocol: u.protocol,
    hostname: u.hostname,
    path: fullPath,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  }, {
    model: modelId,
    messages: [{ role: 'user', content: 'Say OK' }],
    stream: false,
  });
}

// ---------------------------------------------------------------------------
// Retry wrapper for RATE_LIMIT / SERVER
// ---------------------------------------------------------------------------
async function callWithRetry(callFn, maxRetries = 3, delays = [2000, 8000, 30000]) {
  let lastResult;
  for (let i = 0; i <= maxRetries; i++) {
    lastResult = await callFn();
    const cls = classify(lastResult.status, lastResult.body || '');
    if (cls !== 'RATE_LIMIT' && cls !== 'SERVER') return lastResult;
    if (i < maxRetries) {
      await sleep(delays[i] || 30000);
    }
  }
  return lastResult;
}

// ---------------------------------------------------------------------------
// Provider → key + call routing
// ---------------------------------------------------------------------------
function getProviderConfig(providerName, baseUrl) {
  const name = providerName.toLowerCase();
  if (name.includes('groq')) return { key: KEY.GROQ, type: 'standard' };
  if (name.includes('mistral')) return { key: KEY.MISTRAL, type: 'standard' };
  if (name.includes('cerebras')) return { key: KEY.CEREBRAS, type: 'standard' };
  if (name.includes('openrouter')) return { key: KEY.OPENROUTER, type: 'standard' };
  if (name.includes('sambanova')) return { key: KEY.SAMBANOVA, type: 'standard' };
  if (name.includes('siliconflow')) return { key: KEY.SILICONFLOW, type: 'standard' };
  if (name.includes('nvidia')) return { key: KEY.NVIDIA, type: 'standard' };
  if (name.includes('hugging face') || name.includes('huggingface')) return { key: KEY.HF, type: 'standard' };
  if (name.includes('gemini') || name.includes('google')) return { key: KEY.GEMINI, type: 'gemini' };
  if (name.includes('cohere')) return { key: KEY.COHERE, type: 'cohere' };
  if (name.includes('cloudflare')) return { key: KEY.CLOUDFLARE, type: 'cloudflare', accountId: KEY.CF_ACCOUNT };
  if (name.includes('github')) return { key: KEY.GITHUB, type: 'standard' };
  if (name.includes('ollama')) return { key: KEY.OLLAMA, type: 'ollama' };
  if (name.includes('aion')) return { key: KEY.AION, type: 'standard' };
  if (name.includes('z ai') || name.includes('zhipu')) return { key: KEY.ZAI, type: 'standard' };
  if (name.includes('modelscope')) return { key: KEY.MODELSCOPE, type: 'standard' };
  if (name.includes('kilo')) return { key: KEY.KILO, type: 'standard', keyless: true };
  if (name.includes('ovhcloud') || name.includes('ovh')) return { key: KEY.OVH, type: 'standard' };
  if (name.includes('llm7')) return { key: null, type: 'standard', keyless: true };
  return { key: null, type: 'standard' };
}

async function callModel(providerName, baseUrl, modelId, cfg) {
  const { key, type, accountId, keyless } = cfg;

  // Cloudflare: needs both token AND account_id; missing either → SKIPPED
  if (type === 'cloudflare' && (!key || !accountId)) {
    return { status: 0, body: 'no CF_API_TOKEN or CF_ACCOUNT_ID configured', _skipped: true };
  }

  // OVHcloud is anonymous (no key needed) — always attempt
  const isOvh = providerName.toLowerCase().includes('ovh');
  // LLM7.io is keyless — always attempt
  const isLlm7 = providerName.toLowerCase().includes('llm7');

  // No key and not a keyless/anonymous provider → SKIPPED
  if (!key && !keyless && !isOvh && !isLlm7) {
    return { status: 0, body: 'no key configured', _skipped: true };
  }

  const callFn = async () => {
    if (type === 'gemini') return callGemini(baseUrl, modelId, key);
    if (type === 'cohere') return callCohere(baseUrl, modelId, key);
    if (type === 'cloudflare') return callCloudflare(baseUrl, modelId, key, accountId);
    if (type === 'ollama') return callOllama(baseUrl, modelId, key);
    return callStandard(baseUrl, modelId, key);
  };

  return callWithRetry(callFn);
}

// ---------------------------------------------------------------------------
// Build result record
// ---------------------------------------------------------------------------
function buildRecord(providerName, modelId, status, bodyStr, cfg, startMs) {
  const latencyMs = Date.now() - startMs;
  const { key, keyless, type } = cfg;

  // SKIPPED cases — no key, or Cloudflare missing credentials
  const isOvh = providerName.toLowerCase().includes('ovh');
  const isLlm7 = providerName.toLowerCase().includes('llm7');

  if (bodyStr && (bodyStr.includes('no key configured') || bodyStr.includes('no CF_API_TOKEN') || bodyStr.includes('missing CF_ACCOUNT_ID'))) {
    return {
      provider: providerName, modelId,
      verdict: 'SKIPPED', httpStatus: null, latencyMs: null,
      errorClass: null, responseSnippet: bodyStr,
      billed: null, evidenceUrl: null,
    };
  }

  if (!key && !keyless && !isOvh && !isLlm7) {
    return {
      provider: providerName, modelId,
      verdict: 'SKIPPED', httpStatus: null, latencyMs: null,
      errorClass: null, responseSnippet: 'no API key configured',
      billed: null, evidenceUrl: null,
    };
  }

  const safeBody = redactKeys(bodyStr || '');
  let parsed = null;
  if (type === 'cloudflare') {
    try { const j = JSON.parse(bodyStr); if (j.success === true && typeof j.result?.response === 'string' && j.result.response.trim()) parsed = j; } catch {}
  }
  else if (type === 'cohere') parsed = parseCohereResponse(bodyStr || '');
  else if (type === 'ollama') parsed = parseOllamaResponse(bodyStr || '');
  else parsed = parseCompletion(bodyStr || '');

  const v = verdict(status, bodyStr || '', parsed);
  const cls = status !== 200 ? classify(status, bodyStr || '') : null;

  // For Gemini geo-block detection
  let finalVerdict = v;
  if (type === 'gemini' && status === 403) {
    if ((bodyStr || '').toLowerCase().includes('location') ||
        (bodyStr || '').toLowerCase().includes('region') ||
        (bodyStr || '').toLowerCase().includes('country')) {
      finalVerdict = 'SKIPPED';
    }
  }

  return {
    provider: providerName, modelId,
    verdict: finalVerdict,
    httpStatus: status,
    latencyMs,
    errorClass: cls,
    responseSnippet: safeBody.slice(0, 500),
    billed: null,
    evidenceUrl: null,
  };
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------
async function run() {
  const dataPath = path.join(ROOT, 'data.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const results = [];

  // Log available keys
  const keyStatus = {};
  for (const [k, v] of Object.entries(KEY)) keyStatus[k] = v ? 'present' : 'absent';
  console.log('\n=== Key inventory ===');
  for (const [k, v] of Object.entries(keyStatus)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('');

  let totalModels = 0;
  let testedModels = 0;

  for (const provider of data.providers) {
    if (filterProvider && provider.name !== filterProvider) continue;

    const cfg = getProviderConfig(provider.name, provider.baseUrl);
    const isOvh = provider.name.toLowerCase().includes('ovh');

    for (let mi = 0; mi < provider.models.length; mi++) {
      const model = provider.models[mi];
      if (model.id === null) continue; // placeholder row
      if (filterModel && model.id !== filterModel) continue;

      totalModels++;
      const label = `${provider.name} / ${model.id}`;
      process.stdout.write(`  Testing ${label} ... `);

      // OVHcloud: space calls ≥30s to avoid 429 across models
      if (isOvh && mi > 0) {
        process.stdout.write('(waiting 31s for OVH rate limit) ');
        await sleep(31000);
      }

      const startMs = Date.now();
      const raw = await callModel(provider.name, provider.baseUrl, model.id, cfg);
      const record = buildRecord(provider.name, model.id, raw.status, raw.body, cfg, startMs);
      results.push(record);
      testedModels++;

      console.log(record.verdict + (record.errorClass ? ` [${record.errorClass}]` : '') +
        (record.httpStatus ? ` HTTP ${record.httpStatus}` : '') +
        ` ${record.latencyMs != null ? record.latencyMs + 'ms' : ''}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Base URL connectivity checks for SKIPPED providers
  // ---------------------------------------------------------------------------
  const skippedProviders = new Set(
    results.filter(r => r.verdict === 'SKIPPED').map(r => r.provider)
  );
  const baseUrlChecks = [];
  if (skippedProviders.size > 0) {
    console.log('\n=== Base URL connectivity checks (SKIPPED providers) ===');
    for (const provider of data.providers) {
      if (!skippedProviders.has(provider.name)) continue;
      const rawUrl = provider.baseUrl || '';
      // Resolve {account_id} placeholder if present
      const resolvedUrl = rawUrl.replace('{account_id}', KEY.CF_ACCOUNT || 'unknown');
      const u = parseUrl(resolvedUrl);
      if (!u) {
        baseUrlChecks.push({ provider: provider.name, baseUrl: rawUrl, status: 'SKIPPED', reason: 'unparseable URL' });
        console.log(`  ${provider.name}: SKIPPED (unparseable URL)`);
        continue;
      }
      const pingPath = u.pathname || '/';
      process.stdout.write(`  ${provider.name} (${u.hostname}) ... `);
      const startMs = Date.now();
      const res = await httpRequest({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: pingPath,
        method: 'GET',
        protocol: u.protocol,
        headers: { 'User-Agent': 'awesome-free-llm-apis-verifier/1.0' },
      }, null);
      const latency = Date.now() - startMs;
      // Any HTTP response (even 4xx) means the host is reachable
      const reachable = res.status > 0;
      const checkStatus = reachable ? 'REACHABLE' : 'UNREACHABLE';
      baseUrlChecks.push({
        provider: provider.name,
        baseUrl: rawUrl,
        status: checkStatus,
        httpStatus: res.status || null,
        latencyMs: latency,
        error: res.status === 0 ? redactKeys(res.body || '') : null,
      });
      console.log(`${checkStatus} HTTP ${res.status} ${latency}ms`);
    }
  }

  // Write report
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    const report = { modelResults: results, baseUrlChecks };
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${outFile}`);
  }

  console.log(`\nTested ${testedModels} models (of ${totalModels} non-placeholder)`);
  console.log(`Base URL checks: ${baseUrlChecks.filter(c => c.status === 'REACHABLE').length} REACHABLE, ${baseUrlChecks.filter(c => c.status === 'UNREACHABLE').length} UNREACHABLE`);
  return { modelResults: results, baseUrlChecks };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------
async function runSelfTest() {
  const assert = require('node:assert/strict');
  assert.equal(classify(401, ''), 'AUTH');
  assert.equal(classify(429, ''), 'RATE_LIMIT');
  assert.equal(classify(402, ''), 'BILLING');
  assert.equal(classify(0, ''), 'NETWORK');
  assert.equal(parseCompletion('{"choices": [{}]}'), null);
  assert.equal(verdict(200, '{}', null), 'UNKNOWN');
  assert.ok(parseCompletion('{"choices":[{"message":{"content":"OK"}}]}'));
  assert.ok(parseCohereResponse('{"message":{"content":[{"text":"OK"}]}}'));
  assert.equal(parseCohereResponse('{"message":{"content":[]}}'), null);
  assert.ok(parseOllamaResponse('{"message":{"content":"OK"}}'));
  const cf = buildRecord('Cloudflare Workers AI', 'test', 200,
    '{"success":true,"result":{"response":"OK"}}', {type:'cloudflare',key:'test'}, Date.now());
  assert.equal(cf.verdict, 'PASS');
  assert.equal(getProviderConfig('Kilo Code').keyless, true);
  console.log('Offline self-test: 12 assertions passed; no external requests.');
  return true;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
if (require.main === module) (async () => {
  try {
    if (selfTest) {
      await runSelfTest();
      process.exit(0);
    }
    const passed = await runSelfTest();
    if (!passed) {
      console.error('Aborting: harness self-test failed');
      process.exit(2);
    }
    await run();
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
