/**
 * kaggle-llm-control — Cloudflare Worker
 * ==========================================================================
 * One always-on Worker that does three jobs:
 *
 *   1. CONTROL PAGE  (password-protected)
 *        GET  /                 login / Start-Stop page
 *        POST /api/login        set the auth cookie
 *        POST /api/start        ENABLE the GitHub workflow, then DISPATCH it
 *        POST /api/stop         stop the live session, then DISABLE the workflow
 *        GET  /api/status       workflow state + live tunnel URL
 *
 *   2. STABLE FRONT DOOR for Open WebUI
 *        GET/POST /v1/*         proxied to whatever tunnel the notebook registered
 *        POST /update-tunnel    the notebook registers its trycloudflare URL here
 *
 *   3. HEALTH
 *        GET  /health
 *
 * WHY THIS SHAPE
 *   - A disabled workflow can't be dispatched (GitHub returns 422), so Start
 *     must enable() first, then dispatch().
 *   - Disabling is what stops the cron from booting the notebook again; nothing
 *     re-enables it automatically.
 *   - Quick-tunnel URLs change every session, so /v1 points at this Worker and
 *     the Worker follows the current tunnel via KV.
 *
 * BINDINGS / VARIABLES (Worker > Settings > Variables)
 *   GITHUB_TOKEN    secret  fine-grained PAT: Actions=write, Contents=read on the repo
 *   GITHUB_REPO     text    "owner/repo"
 *   WORKFLOW_FILE   text    "kaggle-schedule.yml"
 *   GITHUB_REF      text    "main"           (default branch)
 *   PANEL_PASS      secret  password for the control page
 *   WORKER_SECRET   secret  shared with the notebook (tunnel registration)
 *   API_KEY         secret  bearer key Open WebUI sends to /v1
 *   NTFY_TOPIC      text    optional ntfy.sh topic for start/stop pings
 *   TUNNEL_KV       KV      namespace binding (stores the live tunnel URL)
 * ==========================================================================
 */

const JSON_HEADERS = { "content-type": "application/json" };

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS, ...extra } });
}

// ------------------------------------------------------------------ auth
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function readCookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : "";
}

async function isAuthed(request, env) {
  const expected = await sha256hex("panel:" + (env.PANEL_PASS || ""));
  const got = readCookie(request, "kaggle_llm_auth");
  return got && timingSafeEqual(got, expected);
}

// ------------------------------------------------------------------ GitHub API
async function gh(env, path, method = "GET", body = null) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "kaggle-llm-control",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function notify(env, title, message, tags = "robot", priority = "default") {
  if (!env.NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      method: "POST",
      body: message,
      headers: { Title: title, Tags: tags, Priority: priority },
    });
  } catch (e) { /* best effort */ }
}

// ------------------------------------------------------------------ HTML
const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Kaggle LLM — login</title>
<style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f1117;color:#e8eaed;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#171a22;border:1px solid #262b36;border-radius:14px;padding:2rem;width:300px}
h1{font-size:1.1rem;margin:0 0 1rem}input{width:100%;box-sizing:border-box;padding:.7rem;margin-bottom:.8rem;
border-radius:9px;border:1px solid #2c3340;background:#0b0d12;color:#e8eaed;font:inherit}
button{width:100%;padding:.75rem;border:0;border-radius:9px;background:#2563eb;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:#ff6b6b;font-size:.85rem;margin-bottom:.6rem}</style></head>
<body><form method="POST" action="/api/login">
<h1>Kaggle LLM control</h1>__ERR__
<input type="password" name="password" placeholder="Password" autofocus required>
<button>Log in</button></form></body></html>`;

const PANEL_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Kaggle LLM control</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f1117;color:#e8eaed;margin:0;padding:2rem}
.card{max-width:660px;margin:0 auto;background:#171a22;border:1px solid #262b36;border-radius:14px;padding:1.6rem}
h1{font-size:1.25rem;margin:0 0 .2rem}.sub{color:#9aa0aa;font-size:.9rem;margin-bottom:1.2rem}
.row{display:flex;gap:1.4rem;margin:.8rem 0 1.4rem}
.stat{flex:1}.lbl{color:#9aa0aa;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
.val{font-weight:600;margin-top:.2rem;word-break:break-all}
.on{color:#3ddc84}.off{color:#ff6b6b}.wait{color:#e0b040}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:.85rem 1.5rem;cursor:pointer;margin-right:.6rem}
.start{background:#0a7d32;color:#fff}.stop{background:#b00020;color:#fff}
button:disabled{opacity:.4;cursor:not-allowed}
code{background:#0b0d12;padding:.15rem .4rem;border-radius:6px;font-size:.82rem;word-break:break-all}
.log{margin-top:1.2rem;color:#9aa0aa;font-size:.82rem;min-height:1.2em}
</style></head><body><div class="card">
<h1>Kaggle LLM server</h1>
<div class="sub">control plane — workflow + tunnel</div>
<div class="row">
  <div class="stat"><div class="lbl">Workflow</div><div class="val" id="wf">…</div></div>
  <div class="stat"><div class="lbl">Live session</div><div class="val" id="tn">…</div></div>
</div>
<button class="start" id="btnStart" onclick="act('start')">Start</button>
<button class="stop"  id="btnStop"  onclick="act('stop')">Stop</button>
<div class="log" id="log"></div>
</div>
<script>
async function refresh(){
  try{
    const r = await fetch('/api/status'); const d = await r.json();
    const wf = document.getElementById('wf'), tn = document.getElementById('tn');
    if(d.workflow === 'active'){ wf.textContent='enabled'; wf.className='val on'; }
    else if(d.workflow){ wf.textContent=d.workflow; wf.className='val off'; }
    else { wf.textContent='unknown'; wf.className='val wait'; }
    if(d.tunnel){ tn.textContent=d.tunnel; tn.className='val on'; }
    else if(d.providers && d.providers.length){ tn.textContent=d.providers.join(' · '); tn.className='val on'; }
    else { tn.textContent='none (press Start)'; tn.className='val off'; }
    document.getElementById('btnStart').disabled = (d.workflow==='active');
    document.getElementById('btnStop').disabled  = (d.workflow!=='active' && !d.tunnel);
  }catch(e){ document.getElementById('log').textContent='status error: '+e; }
}
async function act(a){
  const log=document.getElementById('log');
  log.textContent = a==='start' ? 'Enabling workflow + dispatching…' : 'Stopping session + disabling workflow…';
  document.getElementById('btnStart').disabled=document.getElementById('btnStop').disabled=true;
  try{
    const r = await fetch('/api/'+a, {method:'POST'});
    const d = await r.json();
    log.textContent = d.message || JSON.stringify(d);
  }catch(e){ log.textContent='error: '+e; }
  setTimeout(refresh, 1200);
}
refresh(); setInterval(refresh, 15000);
</script></body></html>`;

// ------------------------------------------------------------------ handlers
async function handleLogin(request, env) {
  const form = await request.formData();
  const pass = String(form.get("password") || "");
  if (!env.PANEL_PASS || !timingSafeEqual(pass, env.PANEL_PASS)) {
    return new Response(LOGIN_HTML.replace("__ERR__", '<div class="err">Wrong password.</div>'),
      { status: 401, headers: { "content-type": "text/html" } });
  }
  const token = await sha256hex("panel:" + env.PANEL_PASS);
  return new Response("", {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": `kaggle_llm_auth=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
      "Cache-Control": "no-store",
    },
  });
}

async function handleStatus(env) {
  let wfState = null;
  try {
    const r = await gh(env, `/actions/workflows/${env.WORKFLOW_FILE}`);
    if (r.ok) wfState = (await r.json()).state; // active | disabled_manually | disabled_inactivity
  } catch (e) {}
  const tunnel = env.TUNNEL_KV ? await env.TUNNEL_KV.get("tunnel:default") : null;
  const providers = configuredProviders(env).map((p) => p.label || p.name);
  const backend = tunnel ? "kaggle" : (providers[0] || "none");
  return json({ workflow: wfState, tunnel, backend, providers });
}

async function handleStart(request, env) {
  const body = await request.json().catch(() => ({}));
  const delay = Math.max(0, Math.min(60, parseInt(body.delay_min ?? "0", 10) || 0));

  // 1. enable first — a disabled workflow cannot be dispatched (GitHub 422)
  const en = await gh(env, `/actions/workflows/${env.WORKFLOW_FILE}/enable`, "PUT");
  if (!en.ok && en.status !== 204) {
    return json({ ok: false, message: `enable failed (${en.status}): ${await en.text()}` }, 502);
  }
  // 2. dispatch it
  const dp = await gh(env, `/actions/workflows/${env.WORKFLOW_FILE}/dispatches`, "POST", {
    ref: env.GITHUB_REF || "main",
    inputs: { action: "start", delay_min: String(delay) },
  });
  if (!dp.ok && dp.status !== 204) {
    return json({ ok: false, message: `dispatch failed (${dp.status}): ${await dp.text()}` }, 502);
  }
  await notify(env, "Kaggle LLM — starting", `Workflow enabled + dispatched (delay ${delay}m).`, "green_circle", "high");
  return json({ ok: true, message: `Workflow enabled and dispatched${delay ? ` (delay ${delay}m)` : ""}. Notebook will boot shortly.` });
}

async function handleStop(request, env) {
  // 1. ask the live session to shut down gracefully (best effort)
  let stopped = false;
  try {
    const tunnel = env.TUNNEL_KV ? await env.TUNNEL_KV.get("tunnel:default") : null;
    const tok = env.TUNNEL_KV ? await env.TUNNEL_KV.get("control_token") : null;
    if (tunnel) {
      const r = await fetch(tunnel.replace(/\/$/, "") + "/admin/stop", {
        method: "POST",
        headers: { "X-Control-Token": tok || "" },
        signal: AbortSignal.timeout(8000),
      });
      stopped = r.ok;
    }
  } catch (e) { /* session may already be gone */ }
  // 2. disable the workflow so the cron can't restart it
  const dis = await gh(env, `/actions/workflows/${env.WORKFLOW_FILE}/disable`, "PUT");
  if (!dis.ok && dis.status !== 204) {
    return json({ ok: false, message: `disable failed (${dis.status}): ${await dis.text()}` }, 502);
  }
  await notify(env, "Kaggle LLM — stopped", `Workflow disabled. Live session ${stopped ? "asked to stop" : "not reachable (already down)"}.`, "red_circle", "high");
  return json({ ok: true, message: `Workflow disabled. ${stopped ? "Live session is shutting down." : "No live session was reachable."}` });
}

async function handleUpdateTunnel(request, env) {
  if (request.headers.get("X-Worker-Secret") !== env.WORKER_SECRET) {
    return json({ error: "forbidden" }, 403);
  }
  const body = await request.json().catch(() => ({}));
  if (!body.url) return json({ error: "url required" }, 400);
  if (env.TUNNEL_KV) {
    await env.TUNNEL_KV.put("tunnel:default", String(body.url));
    if (body.control_token) await env.TUNNEL_KV.put("control_token", String(body.control_token));
  }
  await notify(env, "Kaggle LLM — session up", `Tunnel: ${body.url}`, "white_check_mark", "default");
  return json({ ok: true });
}

// ------------------------------------------------------- model providers
// Ordered fallback for /v1 when no Kaggle session is serving. Every entry is
// OpenAI-compatible; Workers AI uses the binding instead of HTTP. A provider
// whose key isn't configured is skipped automatically.
const PROVIDERS = [
  { name: "google",     key: "GOOGLE_API_KEY",     base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash",                       label: "Google AI Studio" },
  { name: "groq",       key: "GROQ_API_KEY",       base: "https://api.groq.com/openai/v1",                          model: "openai/gpt-oss-120b",                    label: "Groq" },
  { name: "sambanova",  key: "SAMBANOVA_API_KEY",  base: "https://api.sambanova.ai/v1",                             model: "Meta-Llama-3.3-70B-Instruct",            label: "SambaNova" },
  { name: "openrouter", key: "OPENROUTER_API_KEY", base: "https://openrouter.ai/api/v1",                            model: "meta-llama/llama-3.3-70b-instruct:free", label: "OpenRouter" },
];
const AI_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
  "@cf/qwen/qwen3.8-27b",
];
const AI_DEFAULT = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function pickModel(env, requested) {
  if (requested && (AI_MODELS.includes(requested) || String(requested).startsWith("@cf/"))) return requested;
  return env.AI_MODEL || AI_DEFAULT;
}

// Providers that are actually usable right now (Workers AI is a binding, so
// it's always available when the [ai] binding is present).
function configuredProviders(env) {
  const list = PROVIDERS.filter((p) => env[p.key]);
  if (env.AI) list.push({ name: "workers-ai", binding: true, model: AI_DEFAULT, label: "Cloudflare Workers AI" });
  return list;
}

// Resolve a requested model id back to the provider that serves it.
function findProvider(env, requested) {
  if (!requested) return null;
  const http = PROVIDERS.find((p) => p.model === requested && env[p.key]);
  if (http) return http;
  if (AI_MODELS.includes(requested) && env.AI) return { name: "workers-ai", binding: true, model: requested, label: "Cloudflare Workers AI" };
  return null;
}

// The model list Open WebUI sees: one id per configured provider, plus Workers AI.
function providerModels(env) {
  return configuredProviders(env).flatMap((p) =>
    p.binding
      ? AI_MODELS.map((m) => ({ id: m, object: "model", owned_by: "cloudflare" }))
      : [{ id: p.model, object: "model", owned_by: p.name }]);
}

async function aiChat(bodyText, env, requested) {
  let body = {};
  try { body = JSON.parse(bodyText || "{}"); } catch (e) {}
  const model = pickModel(env, requested != null ? requested : body.model);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const stream = !!body.stream;
  const inputs = { messages, stream };
  if (body.max_tokens) inputs.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") inputs.temperature = body.temperature;

  let out;
  try {
    out = await env.AI.run(model, inputs);
  } catch (e) {
    return json({ error: { message: "Workers AI error: " + (e && e.message ? e.message : e), type: "upstream" } }, 502);
  }

  const id = "chatcmpl-" + Math.random().toString(36).slice(2);
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    const text = typeof out === "string" ? out : (out && out.response != null ? String(out.response) : "");
    const u = (out && out.usage) || {};
    return json({
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0, total_tokens: u.total_tokens || 0 },
    });
  }

  // Translate Workers AI's SSE ({"response":"..."}) into OpenAI chat chunks.
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "", done = false;
  const ts = new TransformStream({
    transform(chunk, controller) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          done = true;
          continue;
        }
        let obj;
        try { obj = JSON.parse(payload); } catch (e) { continue; }
        const piece = obj.response != null ? String(obj.response) : "";
        if (!piece) continue;
        controller.enqueue(enc.encode("data: " + JSON.stringify({
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        }) + "\n\n"));
      }
    },
    flush(controller) {
      if (!done) controller.enqueue(enc.encode("data: [DONE]\n\n"));
    },
  });
  return new Response(out.pipeThrough(ts), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

// Tag every response with which backend served it, so it's visible in curl/Open WebUI.
function withBackend(resp, name) {
  const out = new Response(resp.body, resp);
  out.headers.set("X-Backend", name);
  return out;
}

// Forward an OpenAI-shaped request to one HTTP provider, swapping in that
// provider's model id (so a fallback never sends Google a Groq model name).
async function callProvider(p, env, bodyText) {
  let body = {};
  try { body = JSON.parse(bodyText || "{}"); } catch (e) {}
  body.model = p.model;
  const headers = { "content-type": "application/json", "Authorization": `Bearer ${env[p.key]}` };
  if (p.name === "openrouter") {
    headers["HTTP-Referer"] = "https://kaggle-llm-control.joshifreefire-joshi.workers.dev";
    headers["X-Title"] = "kaggle-llm-control";
  }
  return fetch(p.base.replace(/\/$/, "") + "/chat/completions", { method: "POST", headers, body: JSON.stringify(body) });
}

async function handleProxy(request, env, rest) {
  const auth = request.headers.get("Authorization") || "";
  if (env.API_KEY && auth !== `Bearer ${env.API_KEY}`) {
    return json({ error: { message: "invalid API key", type: "unauthorized" } }, 401);
  }

  // Buffer the body once: reading it twice (proxy attempt, then a provider)
  // would leave the second reader with an empty stream.
  const bodyText = (request.method === "GET" || request.method === "HEAD") ? null : await request.text();

  if (rest === "models") {
    // Merge the live Kaggle model(s) with the provider list, so Open WebUI can
    // see and select either one.
    const local = providerModels(env);
    const tun = env.TUNNEL_KV ? await env.TUNNEL_KV.get("tunnel:default") : null;
    if (tun) {
      try {
        const r = await fetch(tun.replace(/\/$/, "") + "/v1/models", { headers: { Authorization: auth } });
        if (r.ok) {
          const j = await r.json();
          const remote = Array.isArray(j && j.data) ? j.data : [];
          return withBackend(json({ object: "list", data: [...remote, ...local] }), "models");
        }
      } catch (e) { /* fall back to the local list */ }
    }
    return withBackend(json({ object: "list", data: local }), "models");
  }
  if (rest !== "chat/completions") {
    return json({ error: { message: "unsupported path", type: "not_found" } }, 404);
  }

  // 1. Kaggle session first, whenever one is registered. A dead tunnel must not
  //    break /v1, so failures fall through to the provider chain.
  const tunnel = env.TUNNEL_KV ? await env.TUNNEL_KV.get("tunnel:default") : null;
  if (tunnel) {
    try {
      const target = tunnel.replace(/\/$/, "") + "/v1/" + rest;
      const headers = new Headers(request.headers);
      headers.set("X-Forwarded-Host", new URL(request.url).host);
      const resp = await fetch(new Request(target, { method: request.method, headers, body: bodyText }));
      if (resp.status < 500) return withBackend(resp, "kaggle");
    } catch (e) { /* tunnel unreachable — fall through */ }
  }

  // 2. Provider chain. If the requested model names a specific provider, try
  //    that one first, then the rest in order.
  let requested = null;
  try { requested = JSON.parse(bodyText || "{}").model; } catch (e) {}
  const explicit = findProvider(env, requested);
  let chain = configuredProviders(env);
  if (explicit) chain = [explicit, ...chain.filter((p) => p.name !== explicit.name)];

  const errors = [];
  for (const p of chain) {
    try {
      const r = p.binding ? await aiChat(bodyText, env, requested) : await callProvider(p, env, bodyText);
      if (r.status < 400) return withBackend(r, p.name);
      errors.push(`${p.name}:${r.status}`);
    } catch (e) {
      errors.push(`${p.name}:${(e && e.message) || "error"}`);
    }
  }

  return json({ error: { message: `All backends failed (${errors.join(", ") || "none configured"})`, type: "no_backend" } }, 503);
}

// ------------------------------------------------------------------ router
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- public ---
    if (path === "/health") return json({ ok: true, service: "kaggle-llm-control" });

    if (path === "/update-tunnel" && request.method === "POST") {
      return handleUpdateTunnel(request, env);
    }

    if (path.startsWith("/v1/")) {
      return handleProxy(request, env, path.slice(4));
    }

    // --- login ---
    if (path === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }

    // --- everything below needs the panel password ---
    if (!(await isAuthed(request, env))) {
      if (path.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
      return new Response(LOGIN_HTML.replace("__ERR__", ""), { headers: { "content-type": "text/html" } });
    }

    if (path === "/") return new Response(PANEL_HTML, { headers: { "content-type": "text/html" } });
    if (path === "/api/status") return handleStatus(env);
    if (path === "/api/start" && request.method === "POST") return handleStart(request, env);
    if (path === "/api/stop" && request.method === "POST") return handleStop(request, env);

    return json({ error: "not found" }, 404);
  },
};
