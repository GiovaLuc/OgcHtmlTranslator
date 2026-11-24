// Entry point: webhook analogo a Waze/listener/listener.js — riceve un processo OGC
// (stesso schema di un elemento di GeoCacher-frontend/src/assets/processes.json) via
// POST /translate, e traduce in background (alcuni campi possono richiedere una
// chiamata a Ollama, si veda lib/llm/ollamaRenderer.js). Il risultato va sempre su
// file in OUT_DIR (anche lo stato dei job, così sopravvive a un restart: i job interrotti
// vengono ripresi all'avvio) e, se CALLBACK_URL è impostata, viene anche inviato lì via POST non appena
// pronto — GET /translate/:translationId resta comunque disponibile per interrogare lo stato.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const swaggerUi = require('swagger-ui-express');
const { generateHtml } = require('./lib/generateHtml');
const { isAllowedModel, ALLOWED_MODELS, checkOllama } = require('./lib/llm/ollamaRenderer');
const openapiSpec = require('./lib/openapi');
const { saveJob, loadJobs, htmlFile, logFile } = require('./lib/jobStore');
const { buildNetworkGuard } = require('./lib/networkGuard');

const fetch = globalThis.fetch || require('node-fetch');

const app = express();
// Prima di tutto (anche /docs): solo rete locale.
app.use(buildNetworkGuard());
app.use(bodyParser.json());
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

const PORT = process.env.PORT || 3001;
const OUT_DIR = process.env.OUT_DIR || './out';
const CALLBACK_URL = process.env.CALLBACK_URL || '';
const CALLBACK_TIMEOUT_MS = Number(process.env.CALLBACK_TIMEOUT_MS) || 10000;
fs.mkdirSync(OUT_DIR, { recursive: true });

// translationId -> { status: 'pending'|'done'|'error', error? }. Indice in memoria: la fonte di
// verità è su disco (lib/jobStore.js), ricostruito all'avvio da restoreJobs().
const jobs = new Map();

function summarizeLog(log) {
  const count = (source) => log.filter(l => l.source === source).length;
  return `${log.length} fields (${count('static')} static, ${count('llm')} llm, ${count('fallback')} fallback)`;
}

// Invia il risultato (o l'errore) del job alla URL esterna configurata. Best-effort:
// un fallimento del callback non tocca lo stato del job, già scritto su file/memoria
// — il chiamante può sempre recuperarlo via GET /translate/:translationId.
async function sendCallback(translationId, body) {
  if (!CALLBACK_URL) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  try {
    const res = await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`callback responded ${res.status}`);
    console.log(`[${translationId}] callback delivered to ${CALLBACK_URL}`);
  } catch (err) {
    console.error(`[${translationId}] callback failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Liveness per proxy / Docker HEALTHCHECK (il check gira dentro il container, da loopback).
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Esegue un job (nuovo o ripreso dopo un restart) e ne persiste ogni transizione di stato.
// Il record con il body originale resta su disco finché il job è pending; a job finito viene
// riscritto senza `process`.
function runJob(rec) {
  const { translationId, process: process_, model } = rec;
  const meta = { translationId, createdAt: rec.createdAt, processId: process_.id, version: process_.version ?? null, model };

  return generateHtml(process_, { model })
    .then(({ html, log }) => {
      fs.writeFileSync(htmlFile(OUT_DIR, translationId), html);
      fs.writeFileSync(logFile(OUT_DIR, translationId), JSON.stringify({ processId: meta.processId, version: meta.version, model, log }, null, 2));
      saveJob(OUT_DIR, { ...meta, status: 'done' });
      jobs.set(translationId, { status: 'done' });
      console.log(`[${translationId}] done — ${summarizeLog(log)}`);
      return sendCallback(translationId, { translationId, processId: meta.processId, version: meta.version, status: 'done', html, log });
    })
    .catch(err => {
      jobs.set(translationId, { status: 'error', error: err.message });
      try { saveJob(OUT_DIR, { ...meta, status: 'error', error: err.message }); } catch (e) { console.error(`[${translationId}] cannot persist error state: ${e.message}`); }
      console.error(`[${translationId}] failed: ${err.message}`);
      return sendCallback(translationId, { translationId, processId: meta.processId, version: meta.version, status: 'error', error: err.message });
    });
}

// Ripristino all'avvio: i job finiti tornano interrogabili via GET; quelli che erano
// pending vengono rimessi in esecuzione (dal più vecchio), con il callback se configurato.
// Il lavoro già fatto da Ollama per un job interrotto si rifà: la cache delle risposte è in memoria.
function restoreJobs() {
  const { jobs: saved, skipped } = loadJobs(OUT_DIR);
  if (skipped.length) console.warn(`job store: ignored ${skipped.length} unreadable file(s): ${skipped.join(', ')}`);
  let resumed = 0;
  let restored = 0;
  for (const rec of saved) {
    if (rec.status === 'pending') {
      if (!rec.process || !rec.process.id || !rec.process.inputs) {
        jobs.set(rec.translationId, { status: 'error', error: 'Job interrupted and not resumable' });
        continue;
      }
      jobs.set(rec.translationId, { status: 'pending', createdAt: rec.createdAt });
      resumed++;
      console.log(`[${rec.translationId}] resuming interrupted job (process ${rec.process.id})`);
      runJob(rec);
    } else if (rec.status === 'error') {
      jobs.set(rec.translationId, { status: 'error', error: rec.error });
      restored++;
    } else {
      jobs.set(rec.translationId, { status: 'done' });
      restored++;
    }
  }
  console.log(`job store: ${restored} finished job(s) restored, ${resumed} interrupted job(s) resumed`);
}

app.post('/translate', (req, res) => {
  const process_ = req.body;
  const model = process_ && process_.model;
  if (model && !isAllowedModel(model)) {
    return res.status(400).json({ error: `Unknown model "${model}". Allowed: ${[...ALLOWED_MODELS].join(', ')}` });
  }
  if (!process_ || !process_.id || !process_.inputs) {
    return res.status(400).json({ error: 'Process must have "id" and "inputs"' });
  }

  const translationId = crypto.randomUUID();
  const rec = { translationId, status: 'pending', createdAt: Date.now(), processId: process_.id, version: process_.version ?? null, model, process: process_ };
  try {
    saveJob(OUT_DIR, rec); // prima del 202: se non riusciamo a persistere, non promettiamo nulla
  } catch (err) {
    console.error(`[${translationId}] cannot persist job: ${err.message}`);
    return res.status(503).json({ error: 'Cannot persist job' });
  }
  jobs.set(translationId, { status: 'pending', createdAt: rec.createdAt });
  res.status(202).json({ translationId });

  runJob(rec);
});

app.get('/translate/:translationId', (req, res) => {
  const job = jobs.get(req.params.translationId);
  if (!job) return res.status(404).json({ error: 'Unknown translationId' });
  if (job.status === 'done') {
    const id = req.params.translationId;
    try {
      const { log } = JSON.parse(fs.readFileSync(logFile(OUT_DIR, id), 'utf8'));
      return res.json({ status: job.status, html: fs.readFileSync(htmlFile(OUT_DIR, id), 'utf8'), log });
    } catch (err) {
      console.error(`[${id}] result files unreadable: ${err.message}`);
      return res.status(500).json({ status: 'error', error: 'Result files missing or unreadable' });
    }
  }
  if (job.status === 'error') {
    return res.status(500).json({ status: job.status, error: job.error });
  }
  res.json({ status: job.status });
});

restoreJobs();

const server = app.listen(PORT, '0.0.0.0', () => {
  const callbackInfo = CALLBACK_URL ? `callback: ${CALLBACK_URL}` : 'callback: disabled';
  console.log(`OgcHtmlTranslator listening on port ${PORT} (output dir: ${OUT_DIR}, ${callbackInfo})`);
  console.log(`API docs: http://localhost:${PORT}/docs`);
  checkOllama(); // informativo: non blocca né ritarda l'avvio
});

// Node come PID 1 in Docker ignora SIGTERM se non c'è un handler: `docker stop` aspetterebbe
// 10 s e poi killerebbe. I job pending non vanno persi: sono su disco e ripartono all'avvio.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    const running = [...jobs.values()].filter(j => j.status === 'pending').length;
    console.log(`${signal} received — shutting down (${running} pending job(s) will resume at next start)`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
