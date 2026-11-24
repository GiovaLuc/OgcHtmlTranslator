// Renderizza i tipi di schema scalari (string/number/integer/boolean) usando attributi
// di vincolo HTML5 nativi, con un'espressione `extraValid` opzionale per ciò che non possono esprimere.
// Pipeline: instradato qui da classifyField di fieldRenderer.js; il generico formEngine.js valida/raccoglie il risultato.
const { escapeHtml } = require('../template');
const { renderSection } = require('./section');

const STRING_FORMAT_TYPES = { date: 'date', 'date-time': 'datetime-local', time: 'time', email: 'email', uri: 'url' };

function renderString(name, def) {
  const required = def.minOccurs > 0;
  const { format, pattern, minLength, maxLength } = def.schema;
  const inputType = STRING_FORMAT_TYPES[format] || 'text';
  const attrs = [
    pattern ? `pattern="${escapeHtml(pattern)}"` : '',
    minLength !== undefined ? `minlength="${minLength}"` : '',
    maxLength !== undefined ? `maxlength="${maxLength}"` : '',
  ].filter(Boolean).join(' ');
  const control = `<input type="${inputType}" name="${name}" id="${name}" ${attrs}${required ? ' required' : ''}>`;
  return renderSection(name, def, control);
}

function renderNumber(name, def, { integer = false } = {}) {
  const required = def.minOccurs > 0;
  const { minimum, maximum } = def.schema;
  const attrs = [
    minimum !== undefined ? `min="${minimum}"` : '',
    maximum !== undefined ? `max="${maximum}"` : '',
    integer ? 'step="1"' : 'step="any"',
  ].filter(Boolean).join(' ');
  const control = `<input type="number" name="${name}" id="${name}" ${attrs}${required ? ' required' : ''}>`;
  return renderSection(name, def, control);
}

function renderBoolean(name, def) {
  const required = def.minOccurs > 0;
  // A boolean has no native "required means checked" semantics, so an explicit
  // schema default of true is the only case worth pre-checking the box.
  const checked = def.schema.default === true ? ' checked' : '';
  const control = `<input type="checkbox" name="${name}" id="${name}"${checked}${required ? ' required data-extra-valid="value === true"' : ''}>`;
  return renderSection(name, def, control);
}

module.exports = { renderString, renderNumber, renderBoolean };
