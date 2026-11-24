// Renderer di ultima istanza: una textarea modificabile con il JSON grezzo del campo,
// riparsata al submit via `data-raw-json` — mai HTML inventato a partire dal nome del campo.
// Pipeline: usato da generateHtml.js quando sia classifyField sia il percorso Ollama (lib/llm) falliscono per un campo.
const { escapeHtml } = require('../template');
const { renderSection } = require('./section');

function renderTextareaRaw(name, def) {
  const required = def.minOccurs > 0;
  const placeholder = escapeHtml(JSON.stringify(def.schema, null, 2));
  const control = `<textarea name="${name}" id="${name}" rows="4" data-raw-json placeholder="${placeholder}"${required ? ' required' : ''}></textarea>`;
  return renderSection(name, def, control);
}

module.exports = { renderTextareaRaw };
