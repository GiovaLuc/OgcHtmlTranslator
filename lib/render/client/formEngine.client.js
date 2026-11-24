// Legge, valida e raccoglie qualunque campo non-geo scritto secondo il contratto
// dichiarativo (vedi data/rules.txt): <div class="section">...<input name="NAME" ...
// data-extra-valid="EXPR">...<span class="error-msg" id="NAMEErr">...</div>.
// Pipeline: iniettato verbatim in ogni pagina generata da lib/render/formEngine.js; i campi geo vengono raccolti a parte dal proprio script.

function readFieldValue(form, el) {
  if (el.type === 'radio') {
    // Radios sharing a name resolve as a RadioNodeList off form.elements -- reading
    // .value there gives the checked one's value (or '' if none is checked), unlike
    // el.value on a single radio which is always that radio's own static value.
    return form.elements[el.name].value;
  }
  if (el.type === 'checkbox') return el.checked;
  if (el.multiple) return Array.from(el.selectedOptions).map(o => o.value);
  if (el.dataset.rawJson !== undefined) {
    try { return JSON.parse(el.value); } catch (e) { return undefined; }
  }
  if (el.dataset.arrayItems) {
    if (el.value.trim() === '') return [];
    const parts = el.value.split(',').map(s => s.trim()).filter(s => s !== '');
    return el.dataset.arrayItems === 'number' ? parts.map(Number) : parts;
  }
  if (el.type === 'number') {
    const n = el.step === '1' ? parseInt(el.value, 10) : parseFloat(el.value);
    return el.value === '' ? undefined : n;
  }
  return el.value.trim();
}

function isEmptyValue(v) {
  return v === undefined || v === null || v === '' || (typeof v === 'number' && isNaN(v)) ||
    (Array.isArray(v) && v.length === 0);
}

// Never eval/new Function: expr was already vetted server-side by
// lib/llm/sanitizeLlmOutput.js against the exact same node/call whitelist (see
// lib/render/exprLanguage.js), and here it's parsed by jsep and walked by
// evalExprNode -- an expression can only do what that interpreter explicitly
// implements.
function evalExtraValid(expr, value) {
  try {
    const ast = jsep(expr);
    assertSafeExprNode(ast, expr);
    return evalExprNode(ast, { value, now: Date.now() });
  } catch (e) {
    return true; // an unreadable/unsafe expression never blocks submission
  }
}

function setNestedPayload(payload, name, value) {
  const dot = name.indexOf('.');
  if (dot === -1) { payload[name] = value; return; }
  const group = name.slice(0, dot);
  const key = name.slice(dot + 1);
  if (!payload[group] || typeof payload[group] !== 'object') payload[group] = {};
  payload[group][key] = value;
}

// Runs the declarative engine over every plain [name] field in the form.
// Returns `valid` and writes collected values into `payload` — geo fields are
// collected separately by geoRenderer's own script, which merges into the same
// payload object after this runs.
function runFormEngine(form, payload) {
  let valid = true;
  const seen = new Set();
  Array.from(form.elements).forEach(el => {
    if (!el.name || seen.has(el.name) || el.dataset.geoField !== undefined || el.disabled) return;
    seen.add(el.name);

    const value = readFieldValue(form, el);
    const required = el.required;
    const empty = isEmptyValue(value);

    let fieldValid = true;
    if (required && empty) fieldValid = false;
    if (!empty && !el.checkValidity()) fieldValid = false;
    if (!empty && fieldValid && Array.isArray(value)) {
      const min = el.dataset.minItems !== undefined ? Number(el.dataset.minItems) : undefined;
      const max = el.dataset.maxItems !== undefined ? Number(el.dataset.maxItems) : undefined;
      if ((min !== undefined && value.length < min) || (max !== undefined && value.length > max)) {
        fieldValid = false;
      }
    }
    if (!empty && fieldValid && el.dataset.extraValid) {
      fieldValid = evalExtraValid(el.dataset.extraValid, value);
    }

    const errEl = document.getElementById(el.name + 'Err') ||
      document.getElementById(el.id + 'Err');
    if (errEl) errEl.style.display = fieldValid ? 'none' : 'block';
    if (!fieldValid) valid = false;

    if (!empty) setNestedPayload(payload, el.name, value);
  });
  return valid;
}
