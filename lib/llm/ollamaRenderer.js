// Chiama un modello Ollama locale per tradurre un campo (scalare o geo) che il
// classificatore statico non ha riconosciuto, e valida la risposta prima di restituirla.
// Pipeline: chiamato da lib/generateHtml.js dopo che lib/classify rifiuta un campo; lancia un errore in caso di fallimento, così il chiamante può degradare a una textarea JSON grezza.
const crypto = require('crypto');
const { buildOllamaPrompt } = require('./ollamaPrompt');
const { buildOllamaGeoPrompt } = require('./ollamaGeoPrompt');
const { sanitizeLlmField } = require('./sanitizeLlmOutput');
const { sanitizeLlmGeoField } = require('./sanitizeLlmGeoField');
// Node 18+ has fetch built in; this falls back to node-fetch on older runtimes
// (e.g. local dev on Node 16) without needing a global polyfill.
const fetch = globalThis.fetch || require('node-fetch');

const DEFAULT_ALLOWED_MODELS = ['starcoder2:instruct', 'fl0id/teuken-7b-instruct-commercial-v0.4:latest', 'qwen2.5-coder:1.5b'];
const ALLOWED_MODELS = new Set(
  process.env.OLLAMA_ALLOWED_MODELS
    ? process.env.OLLAMA_ALLOWED_MODELS.split(',').map(m => m.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_MODELS
);
const BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 30000;
const DEFAULT_MODEL = process.env.OLLAMA_DEFAULT_MODEL || 'qwen2.5-coder:1.5b';

// Modelli per cui non applicare nessun timeout (aspetta finché Ollama non risponde,
// qualunque sia il tempo necessario), elencati per nome esatto in OLLAMA_NO_TIMEOUT_MODELS
// separati da virgola — es. un modello grande su hardware lento che a volte impiega
// minuti per il solo prompt processing (vedi server.log di Ollama) ma arriva sempre a
// una risposta se gli si lascia il tempo. Tutti gli altri modelli restano su TIMEOUT_MS.
const NO_TIMEOUT_MODELS = new Set(
  (process.env.OLLAMA_NO_TIMEOUT_MODELS || '').split(',').map(m => m.trim()).filter(Boolean)
);

function isAllowedModel(model) {
  return ALLOWED_MODELS.has(model);
}

// Cache in-process, keyed sull'hash di modello+prompt: due campi con nome, schema,
// modello e contesto (altri nomi campo) identici producono lo stesso identico prompt,
// quindi la stessa risposta è sicura da riusare senza richiamare Ollama. Nessun TTL —
// il prompt include già tutto ciò che potrebbe cambiare il risultato; sopravvive per
// l'intera vita del processo Node (persa a un restart, accettabile come per `jobs`).
//
// Cachiamo la Promise stessa, non solo il risultato finale: due richieste concorrenti
// con lo stesso prompt (es. lo stesso campo classificato in due job paralleli) devono
// agganciarsi alla STESSA chiamata in corso, altrimenti entrambe troverebbero la cache
// vuota nella finestra prima che la prima abbia finito e partirebbero in parallelo.
const responseCache = new Map(); // cacheKey -> Promise<rawText>

function cacheKeyFor(model, prompt, options) {
  return crypto.createHash('sha256')
    .update(model).update('\n')
    .update(JSON.stringify(options || {})).update('\n')
    .update(prompt).digest('hex');
}

// Coda globale one-at-a-time: tutte le chiamate a Ollama, di qualunque job/campo/
// modello, sono serializzate qui. Job concorrenti (richieste /translate ravvicinate)
// altrimenti aprirebbero N chiamate parallele allo stesso Ollama locale, che le
// processa comunque una alla volta — accodarle esplicitamente evita di sovraccaricarlo
// e rende i tempi di risposta prevedibili invece che degradare tutti insieme.
// Coda esplicita: un array di task in attesa più un flag che dice se ne sta già
// girando uno. Ogni nuovo task entra in coda; processQueue lavora un elemento alla
// volta e, quando finisce, richiama se stesso finché la coda non è vuota.
const queue = [];
let processing = false;

function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (processing) return; // già in corso un ciclo: quello svuoterà la coda
  processing = true;
  while (queue.length > 0) {
    const { task, resolve, reject } = queue.shift();
    try {
      resolve(await task());
    } catch (err) {
      reject(err);
    }
  }
  processing = false;
}

// Alcuni modelli (es. starcoder2:instruct), pur istruiti a rispondere con solo
// l'oggetto JSON, continuano a generare oltre la risposta vera e propria — a volte
// degenerando in testo completamente estraneo (osservato: un file di documentazione
// Markdown allucinato) finché non esauriscono il budget di token. Un limite esplicito
// sul numero di token generati evita questa deriva senza il rischio di una stop
// sequence testuale: "\n```" era stata provata come stop, ma coincide sia con
// l'apertura (```json) sia con la chiusura del fence — osservato un caso in cui ha
// troncato la generazione un istante PRIMA che il modello scrivesse la risposta vera.
// 400 token copre le risposte "oneste" osservate (anche con ragionamento passo-passo
// in prosa prima del JSON, viste fino a ~334 token per arrivarci) senza lasciare
// spazio a centinaia di token di deriva dopo che la risposta è già stata data.
const MAX_GEO_RESPONSE_TOKENS = 400;

async function callOllamaUncached(prompt, model, { numPredict, jsonFormat } = {}) {
  // Nessun AbortController per i modelli in NO_TIMEOUT_MODELS: fetch resta in attesa
  // finché Ollama non risponde, invece di abortire una richiesta che magari era solo
  // lenta a elaborare un prompt lungo su CPU, non bloccata.
  const noTimeout = NO_TIMEOUT_MODELS.has(model);
  const controller = noTimeout ? null : new AbortController();
  const timer = noTimeout ? null : setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, prompt, stream: false,
        // format: "json" constrains decoding itself — the model can only sample
        // tokens that keep the output valid JSON, so it physically cannot write
        // prose around the answer (verified: a model that previously wrote several
        // paragraphs of reasoning plus an unrelated hallucinated doc file produced
        // ONLY a bare JSON object with this set, nothing before or after).
        ...(jsonFormat ? { format: 'json' } : {}),
        ...(numPredict ? { options: { num_predict: numPredict } } : {}),
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
    const data = await res.json();
    return data.response || '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Punto d'ingresso unico per ogni chiamata a Ollama in questo file: prima controlla
// la cache, poi (solo su miss) accoda la chiamata reale. Un hit — anche su una
// richiesta ancora in corso — non passa dalla coda: non c'è motivo di far aspettare
// due volte dietro chiamate lente.
function callOllama(prompt, model, options) {
  const key = cacheKeyFor(model, prompt, options);
  const cached = responseCache.get(key);
  if (cached) return cached;

  const pending = enqueue(() => callOllamaUncached(prompt, model, options));
  responseCache.set(key, pending);
  // Una chiamata fallita non deve restare "in cache" come fallimento permanente —
  // il prossimo tentativo (stesso prompt) deve poter riprovare da capo.
  pending.catch(() => responseCache.delete(key));
  return pending;
}

// `process` and `otherFieldNames` give the model a little context about the rest
// of the form (see lib/ollamaPrompt.js); neither is required for correctness.
async function renderFieldWithOllama(name, def, process, otherFieldNames, { model } = {}) {
  const chosenModel = model && isAllowedModel(model) ? model : DEFAULT_MODEL;
  const prompt = buildOllamaPrompt(name, def, process, otherFieldNames);
  const rawText = await callOllama(prompt, chosenModel);
  const html = sanitizeLlmField(name, rawText, def.schema);
  return { html, model: chosenModel };
}

// Same call/timeout/model machinery as renderFieldWithOllama, but for a "geo-unknown"
// field: asks the model to classify the field's map role instead of writing HTML (see
// lib/ollamaGeoPrompt.js), and validates the response against the schema (see
// lib/sanitizeLlmGeoField.js) instead of against emitted markup. Returns
// { role, wrapper, requiredProp, model } — the caller (lib/generateHtml.js) feeds
// this straight into describeGeoField/renderGeoFields alongside the static geo kinds.
// numPredict/jsonFormat are set here (not in renderFieldWithOllama, which expects
// HTML, not JSON) because only this path has shown models drifting into prose and
// unrelated generated text well past a valid answer.
async function renderGeoFieldWithOllama(name, def, process, otherFieldNames, { model } = {}) {
  const chosenModel = model && isAllowedModel(model) ? model : DEFAULT_MODEL;
  const prompt = buildOllamaGeoPrompt(name, def, process, otherFieldNames);
  const rawText = await callOllama(prompt, chosenModel, { numPredict: MAX_GEO_RESPONSE_TOKENS, jsonFormat: true });
  const classification = sanitizeLlmGeoField(name, rawText, def);
  return { ...classification, model: chosenModel };
}

// Controllo all'avvio, solo informativo: Ollama serve soltanto per i campi che il classificatore
// statico non riconosce (vedi generateHtml.js), quindi un Ollama giù NON ferma il servizio — i
// job che non lo richiedono funzionano comunque. Segnala nel log se Ollama non risponde o se
// mancano modelli, così il degrado (campi in textarea JSON) non resta una sorpresa.
// Mai lancia e non blocca l'avvio; ritorna { reachable, missing } per chi vuole usarlo.
async function checkOllama({ timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/api/tags`, { signal: controller.signal });
    if (!res.ok) throw new Error(`responded ${res.status}`);
    const data = await res.json();
    // Ollama elenca "nome:tag"; un nome senza tag in configurazione significa ":latest".
    const installed = new Set((data.models || []).map(m => m.name));
    const has = (m) => installed.has(m) || (!m.includes(':') && installed.has(`${m}:latest`));
    const wanted = [...new Set([DEFAULT_MODEL, ...ALLOWED_MODELS])];
    const missing = wanted.filter(m => !has(m));
    if (!missing.includes(DEFAULT_MODEL)) {
      console.log(`Ollama reachable at ${BASE_URL} (default model "${DEFAULT_MODEL}" present)`);
    }
    if (missing.length) {
      const detail = missing.map(m => m === DEFAULT_MODEL ? `${m} (DEFAULT)` : m).join(', ');
      console.warn(`WARNING: Ollama at ${BASE_URL} is missing model(s): ${detail} — fields needing the LLM that use them will fall back to a raw JSON textarea`);
    }
    return { reachable: true, missing };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `no answer in ${timeoutMs} ms` : (err.cause && err.cause.code) || err.message;
    console.warn(`WARNING: Ollama not reachable at ${BASE_URL} (${reason}) — the service runs, but fields the static classifier does not recognize will fall back to a raw JSON textarea`);
    return { reachable: false, missing: [] };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  renderFieldWithOllama, renderGeoFieldWithOllama, checkOllama,
  isAllowedModel, ALLOWED_MODELS, DEFAULT_MODEL,
};
