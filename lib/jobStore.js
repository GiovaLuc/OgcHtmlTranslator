// Persistenza dei job su disco, così un restart non perde né lo stato né il lavoro in coda.
//
// Per ogni job, in OUT_DIR:
//   <id>.job.json  record di stato: { translationId, status, createdAt, processId, version,
//                  model, error? } — più `process` (il body originale) finché è pending, così
//                  il job può essere rieseguito dopo un restart; viene tolto a job finito.
//   <id>.html      risultato (solo done)
//   <id>.json      log per campo (solo done)
//
// Scritture atomiche (file temporaneo + rename): un crash a metà non lascia un .job.json
// troncato che bloccherebbe l'avvio.
const fs = require('fs');
const path = require('path');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const JOB_FILE = new RegExp(`^(${UUID})\\.job\\.json$`);
const LEGACY_LOG_FILE = new RegExp(`^(${UUID})\\.json$`);

function jobFile(dir, id) { return path.join(dir, `${id}.job.json`); }
function htmlFile(dir, id) { return path.join(dir, `${id}.html`); }
function logFile(dir, id) { return path.join(dir, `${id}.json`); }

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function saveJob(dir, record) {
  writeAtomic(jobFile(dir, record.translationId), JSON.stringify(record));
}

// Legge OUT_DIR e restituisce i job da ripristinare, dal più vecchio al più recente:
//  - .job.json validi;
//  - risultati "vecchi" (<id>.json + <id>.html senza .job.json, scritti prima di questa
//    versione) come job già done.
// Un job done il cui .html non esiste più viene scartato (404 è più onesto di un 500 al GET).
function loadJobs(dir) {
  const records = new Map();
  const skipped = [];
  const files = fs.readdirSync(dir);

  for (const name of files) {
    const m = JOB_FILE.exec(name);
    if (!m) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (rec && rec.translationId === m[1] && ['pending', 'done', 'error'].includes(rec.status)) {
        records.set(m[1], rec);
      } else {
        skipped.push(name);
      }
    } catch {
      skipped.push(name);
    }
  }

  for (const name of files) {
    const m = LEGACY_LOG_FILE.exec(name);
    if (!m || records.has(m[1])) continue;
    if (!fs.existsSync(htmlFile(dir, m[1]))) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      records.set(m[1], {
        translationId: m[1],
        status: 'done',
        createdAt: fs.statSync(htmlFile(dir, m[1])).mtimeMs,
        processId: meta.processId ?? null,
        version: meta.version ?? null,
        model: meta.model,
      });
    } catch {
      skipped.push(name);
    }
  }

  const list = [...records.values()].filter(rec => {
    if (rec.status !== 'done') return true;
    return fs.existsSync(htmlFile(dir, rec.translationId)) && fs.existsSync(logFile(dir, rec.translationId));
  });
  list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return { jobs: list, skipped };
}

module.exports = { saveJob, loadJobs, htmlFile, logFile };
