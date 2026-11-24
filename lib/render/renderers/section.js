// Avvolge un singolo controllo nativo nel contratto di campo condiviso <div class="section">.
// Pipeline: usato da ogni renderer in questa cartella, e replicato dal prompt LLM in lib/llm/ollamaPrompt.js.
const { escapeHtml } = require('../template');

// `controlHtml` is the bare control (<input>, <select>, <textarea>) already carrying
// name/id/required/native constraints/data-extra-valid. This just adds the title,
// hint, optional badge and error span around it.
function renderSection(name, def, controlHtml) {
  const required = def.minOccurs > 0;
  const html = `  <div class="section">
    <div class="section-title">${escapeHtml(def.title)}${required ? '' : ' <span class="optional-badge">optional</span>'}</div>
    ${def.description ? `<p class="hint">${escapeHtml(def.description)}</p>` : ''}
    ${controlHtml}
    <span class="error-msg" id="${name}Err">Invalid value.</span>
  </div>`;
  return { html };
}

function humanize(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function jsVarName(fieldName) {
  return fieldName.replace(/[^a-zA-Z0-9_]/g, '_');
}

module.exports = { renderSection, humanize, jsVarName };
