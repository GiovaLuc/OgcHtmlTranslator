// Renderizza gli schemi `enum` come const (nessun controllo), radio card (poche opzioni) o select (molte).
// Pipeline: instradato qui da classifyField di fieldRenderer.js; il generico formEngine.js raccoglie il valore dal `name` nativo del controllo.
const { escapeHtml } = require('../template');
const { renderSection } = require('./section');

// Single-value enum: nothing to show, the value is injected as a constant payload
// entry directly by the caller (see lib/generateHtml.js) — never a form control.
function renderConst(name, def) {
  return { html: '', constValue: def.schema.enum[0] };
}

function renderEnumSelect(name, def) {
  const required = def.minOccurs > 0;
  const options = def.schema.enum
    .map(v => `      <option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
    .join('\n');
  const control = `<select name="${name}" id="${name}"${required ? ' required' : ''}>
      <option value="">— select —</option>
${options}
    </select>`;
  return renderSection(name, def, control);
}

function renderEnumRadio(name, def) {
  const required = def.minOccurs > 0;
  const cards = def.schema.enum.map((v, i) => `      <div class="radio-card">
        <input type="radio" name="${name}" id="${name}_${i}" value="${escapeHtml(v)}"${i === 0 && required ? ' required' : ''}>
        <label for="${name}_${i}">${escapeHtml(v)}</label>
      </div>`).join('\n');
  const control = `<div class="radio-card-grid">
${cards}
    </div>`;
  return renderSection(name, def, control);
}

module.exports = { renderConst, renderEnumSelect, renderEnumRadio };
