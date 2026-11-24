// Assembla lo script del motore form lato browser a partire da client/*.client.js
// (JS browser puro, letto via fs.readFileSync, mai generato via .toString()) più il parser jsep.
// Pipeline: chiamato da template.js per costruire l'unico tag <script> che ogni pagina generata include.
const fs = require('fs');
const path = require('path');

const CLIENT_DIR = path.join(__dirname, 'client');

// jsep, bundled verbatim (IIFE build, browser-ready, ~2.5kb) so the page never
// fetches it from a CDN and stays a fully standalone document.
const JSEP_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'node_modules', 'jsep', 'dist', 'iife', 'jsep.iife.min.js'), 'utf8'
);

// The safe expression interpreter (lib/render/exprLanguage.js) re-expressed for the
// browser: same node/operator/function set as the server-side validator in
// lib/llm/sanitizeLlmOutput.js, just without the Node `module.exports` wrapper.
function buildExprInterpreterSource() {
  const source = fs.readFileSync(path.join(__dirname, 'exprLanguage.js'), 'utf8');
  return source
    .replace(/^const \{[^}]*\} = require\(.*$/m, '') // no jsep require() in the browser; the IIFE above defines the global
    .replace(/^module\.exports[\s\S]*$/m, '');
}

function buildFormEngineScript() {
  return [
    JSEP_SOURCE,
    buildExprInterpreterSource(),
    '// ── Motore generico campi dichiarativi ──────────────────────────────────',
    fs.readFileSync(path.join(CLIENT_DIR, 'formEngine.client.js'), 'utf8'),
  ].join('\n\n');
}

function buildOneOfToggleScript() {
  return fs.readFileSync(path.join(CLIENT_DIR, 'oneOfToggle.client.js'), 'utf8');
}

module.exports = { buildFormEngineScript, buildOneOfToggleScript };
