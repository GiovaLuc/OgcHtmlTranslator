// Valida e sanifica l'HTML di un campo prodotto da Ollama contro l'esatto contratto
// dichiarativo che ogni campo deve rispettare, lanciando un errore per ciò che non corrisponde.
// Pipeline: chiamato da ollamaRenderer.js subito dopo la risposta del modello; un errore qui instrada il campo al fallback textarea JSON grezzo invece che a markup non verificato.
const { parse } = require('node-html-parser');
const jsep = require('jsep');
const { assertSafeExprNode } = require('../render/exprLanguage');

const ALLOWED_TAGS = new Set(['div', 'span', 'p', 'label', 'input', 'select', 'option', 'textarea']);
const ALLOWED_ATTRS = new Set([
  'class', 'id', 'name', 'type', 'value', 'min', 'max', 'step', 'pattern',
  'minlength', 'maxlength', 'required', 'placeholder', 'data-extra-valid', 'multiple',
]);

function extractSectionBlock(rawText) {
  const start = rawText.indexOf('<div class="section">');
  if (start === -1) throw new Error('No <div class="section"> block found in LLM output');
  let depth = 0;
  let i = start;
  const openTag = /<div\b[^>]*>/i;
  const closeTag = /<\/div>/i;
  while (i < rawText.length) {
    const nextOpen = rawText.slice(i).search(openTag);
    const nextClose = rawText.slice(i).search(closeTag);
    if (nextClose === -1) throw new Error('Unbalanced <div> in LLM output');
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      i += nextOpen + rawText.slice(i + nextOpen).match(openTag)[0].length;
    } else {
      depth -= 1;
      i += nextClose + 6; // length of "</div>"
      if (depth === 0) return rawText.slice(start, i);
    }
  }
  throw new Error('Unbalanced <div> in LLM output');
}

// KNOWN GAP: this only checks that the expression is syntactically safe (see
// exprLanguage.js) — it does NOT check that the constraint it encodes is actually
// justified by the field's title/description. In testing, the model has invented
// plausible-sounding constraints nobody asked for (e.g. a minimum string length on
// a field with no such requirement, or "value >= 0" on a plain number) and those
// pass this check as long as the expression itself is well-formed. Accepted as a
// residual risk for now: unlike enum-vs-control-type or native attributes (which
// are checked against the schema below), there's no reliable structural way to
// verify an expression against free-text prose without another LLM call.
function validateExtraValid(expr) {
  let ast;
  try {
    ast = jsep(expr);
  } catch (e) {
    throw new Error(`Unparsable data-extra-valid expression: "${expr}"`);
  }
  assertSafeExprNode(ast, expr);
}

// Rejects a couple of patterns a small local model reliably gets wrong even after
// being told not to (see the comparison against fieldRenderer.js's own output for
// the same schema): picking a free-text input for an enum instead of select/radio,
// and inventing min/max/length/step constraints the schema never declared. These are
// deterministic checks against the field's own schema — much more reliable than
// hoping a 1.5B model's prompt-following holds.
function assertMatchesSchema(name, controls, schema) {
  if (Array.isArray(schema.enum)) {
    const isChoiceControl = controls.every(c =>
      c.tagName === 'SELECT' || (c.tagName === 'INPUT' && ['radio', 'checkbox'].includes(c.getAttribute('type'))));
    if (!isChoiceControl) {
      throw new Error(`Field "${name}" has an enum schema but got a free-text control instead of select/radio`);
    }
    const values = controls.flatMap(c =>
      c.tagName === 'SELECT'
        ? c.querySelectorAll('option').map(o => o.getAttribute('value')).filter(v => v)
        : [c.getAttribute('value')]);
    const enumSet = new Set(schema.enum.map(String));
    if (!values.every(v => enumSet.has(v))) {
      throw new Error(`Field "${name}" enum control offers a value outside its schema's enum`);
    }
    // The control itself already constrains the value to one of these options —
    // a data-extra-valid re-checking membership would be redundant at best.
    if (controls.some(c => c.getAttribute('data-extra-valid'))) {
      throw new Error(`Field "${name}" is an enum control and should not need data-extra-valid`);
    }
    return;
  }

  // node-html-parser's getAttribute returns undefined (not null) for an absent
  // attribute — check with `in` on the raw attribute map instead.
  const has = (el, attr) => attr in el.attributes;

  const control = controls[0];
  if (schema.type === 'number' && control.getAttribute('step') === '1') {
    throw new Error(`Field "${name}" is a "number" (not "integer") but got step="1"`);
  }
  if (schema.type === 'integer' && has(control, 'step') && control.getAttribute('step') !== '1') {
    throw new Error(`Field "${name}" is an "integer" but got step="${control.getAttribute('step')}" instead of "1"`);
  }

  // min/max/minlength/maxlength/pattern are only ever legitimate if the schema itself
  // declared the matching constraint — otherwise the model invented it.
  const NATIVE_CONSTRAINT_ATTRS = {
    min: 'minimum', max: 'maximum', minlength: 'minLength', maxlength: 'maxLength', pattern: 'pattern',
  };
  for (const [attr, schemaKey] of Object.entries(NATIVE_CONSTRAINT_ATTRS)) {
    if (has(control, attr) && schema[schemaKey] === undefined) {
      throw new Error(`Field "${name}" has "${attr}" but the schema declares no "${schemaKey}"`);
    }
  }
}

// Throws on any violation; returns the sanitized HTML string (parsed back to string,
// so attribute order/whitespace from the model can't smuggle anything past the checks).
function sanitizeLlmField(name, rawText, schema) {
  const block = extractSectionBlock(rawText);
  const root = parse(block);
  const sectionDiv = root.querySelector('div.section');
  if (!sectionDiv) throw new Error('Missing div.section root');

  const allNodes = sectionDiv.querySelectorAll('*');
  for (const node of [sectionDiv, ...allNodes]) {
    if (!ALLOWED_TAGS.has(node.rawTagName)) {
      throw new Error(`Disallowed tag <${node.rawTagName}>`);
    }
    for (const attr of Object.keys(node.attributes)) {
      if (!ALLOWED_ATTRS.has(attr)) {
        throw new Error(`Disallowed attribute "${attr}" on <${node.rawTagName}>`);
      }
    }
  }

  const controls = sectionDiv.querySelectorAll(`[name="${name}"]`);
  if (controls.length === 0) {
    throw new Error(`Missing control for field "${name}"`);
  }
  if (controls.length === 1 && controls[0].getAttribute('id') !== name) {
    throw new Error(`Missing or mismatched control for field "${name}"`);
  }
  const errSpan = sectionDiv.querySelector(`span.error-msg#${name}Err`);
  if (!errSpan) throw new Error(`Missing error span "${name}Err"`);

  if (schema) assertMatchesSchema(name, controls, schema);

  for (const control of controls) {
    const extraValid = control.getAttribute('data-extra-valid');
    if (extraValid) validateExtraValid(extraValid);
  }

  return sectionDiv.toString();
}

module.exports = { sanitizeLlmField };
