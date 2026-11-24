// Renderizza un oneOf/anyOf/allOf a livello di campo come un selettore esplicito tra
// alternative nominate, ciascuna renderizzata ricorsivamente con le stesse regole classifica-poi-renderizza.
// Pipeline: instradato qui da classifyField di fieldRenderer.js, che inietta `renderField` per evitare un ciclo require(); lo script del toggle vive in oneOfToggle.client.js.
const { escapeHtml } = require('../template');
const { jsVarName } = require('./section');

function alternativeLabel(schema, index) {
  return schema.title || schema.const || `Option ${index + 1}`;
}

function renderOneOf(name, def, renderField) {
  const required = def.minOccurs > 0;
  const alternatives = def.schema.oneOf || def.schema.anyOf || def.schema.allOf;
  const groupVar = jsVarName(name);

  const options = alternatives
    .map((alt, i) => `      <option value="${i}">${escapeHtml(alternativeLabel(alt, i))}</option>`)
    .join('\n');

  const branches = alternatives.map((alt, i) => {
    // Each alternative becomes its own sub-field, named the same as the parent so
    // the generic engine writes straight to `payload[name]` regardless of which
    // branch is active (only the active one is ever enabled, see the toggle script).
    const subDef = { ...def, schema: alt, minOccurs: def.minOccurs, title: alternativeLabel(alt, i) };
    const rendered = renderField(name, subDef);
    return `    <div data-oneof-branch="${groupVar}" data-oneof-value="${i}" style="display:${i === 0 ? '' : 'none'}">
${rendered.html}
    </div>`;
  }).join('\n');

  const html = `  <div class="section">
    <div class="section-title">${escapeHtml(def.title)}${required ? '' : ' <span class="optional-badge">optional</span>'}</div>
    ${def.description ? `<p class="hint">${escapeHtml(def.description)}</p>` : ''}
    <select data-oneof-switch="${groupVar}" id="${name}_choice">
${options}
    </select>
${branches}
  </div>`;
  return { html };
}

module.exports = { renderOneOf };
