// Renderizza uno schema `array` semplice (non geometrico) di elementi scalari come un unico controllo dichiarativo.
// Pipeline: instradato qui da classifyField di fieldRenderer.js; il generico formEngine.js lo raccoglie via `el.multiple` come qualunque altro campo.
const { escapeHtml } = require('../template');
const { renderSection } = require('./section');

function renderArray(name, def) {
  const required = def.minOccurs > 0;
  const items = def.schema.items || {};
  const minItems = def.schema.minItems ?? def.minOccurs;
  const maxItems = def.schema.maxItems ?? def.maxOccurs;

  if (Array.isArray(items.enum)) {
    const options = items.enum
      .map(v => `      <option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
      .join('\n');
    const control = `<select name="${name}" id="${name}" multiple${required ? ' required' : ''}>
${options}
    </select>`;
    return renderSection(name, def, control);
  }

  // No enum to pick from: a comma-separated text field is the only generic way to
  // express a repeatable scalar list without inventing per-item add/remove JS.
  const itemType = items.type === 'integer' || items.type === 'number' ? 'number' : 'text';
  const pattern = itemType === 'number'
    ? '^\\\\s*-?\\\\d+(\\\\.\\\\d+)?(\\\\s*,\\\\s*-?\\\\d+(\\\\.\\\\d+)?)*\\\\s*$'
    : undefined;
  const hint = itemType === 'number' ? ' (comma-separated numbers)' : ' (comma-separated values)';
  const control = `<input type="text" name="${name}" id="${name}"${pattern ? ` pattern="${pattern}"` : ''}${required ? ' required' : ''} data-array-items="${itemType}"${minItems !== undefined ? ` data-min-items="${minItems}"` : ''}${maxItems !== undefined ? ` data-max-items="${maxItems}"` : ''}>`;
  const withHint = { ...def, description: `${def.description || ''}${hint}` };
  return renderSection(name, withHint, control);
}

module.exports = { renderArray };
