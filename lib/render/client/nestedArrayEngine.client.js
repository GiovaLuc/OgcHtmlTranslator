// Motore runtime per campi "nested-array": un campo geo che né il classificatore
// statico né l'LLM hanno saputo mappare su un ruolo noto (role "unrecognized"), ma per
// cui l'LLM ha comunque descritto la forma (nestingDepth/unitSize/labels, vedi
// lib/llm/ollamaGeoPrompt.js + lib/llm/sanitizeLlmGeoField.js) — invece di una textarea
// JSON grezza, questo costruisce un editor a righe annidate, aggiungibili/rimuovibili
// un livello alla volta, che non richiede mai all'utente di vedere lo schema.
// Pipeline: guidato dai descrittori per campo passati come dati all'init (vedi il fondo di questo file); il lato HTML è lib/render/nestedArrayRenderer.js.

class NestedArrayEngine {
  // fields: [{ name, varName, title, nestingDepth, unitSize, labels }]
  constructor(fields) {
    this.fields = fields;
    this.byName = new Map(fields.map(f => [f.name, f]));
    // tree per field: nested arrays down to depth-1, holding leaf "unit" arrays
    // (each unit is `unitSize` numbers) at the deepest level.
    this.trees = new Map(fields.map(f => [f.name, this._emptyNode(f.nestingDepth)]));
    fields.forEach(f => this._renderLevel(f, this.trees.get(f.name), document.getElementById('nested_' + f.varName), []));
  }

  _emptyNode(depth) {
    return { depth, children: [] };
  }

  _nodeAt(fieldName, path) {
    let node = this.trees.get(fieldName);
    for (const idx of path) node = node.children[idx];
    return node;
  }

  // Renders ONE level of nesting into `container`: a labelled card per existing child
  // plus an "add" button. Leaf level (depth === 1) renders unitSize number inputs per
  // child instead of recursing further.
  _renderLevel(f, node, container, path) {
    if (!container) return;
    container.innerHTML = '';
    const label = f.labels[f.labels.length - node.depth];

    node.children.forEach((child, idx) => {
      const card = document.createElement('div');
      card.className = 'nested-card';
      const header = document.createElement('div');
      header.className = 'nested-card-header';
      header.innerHTML = '<span>' + label + ' #' + (idx + 1) + '</span>' +
        '<button type="button" class="btn-remove-feature" data-nested-remove>×</button>';
      header.querySelector('[data-nested-remove]').addEventListener('click', () => {
        node.children.splice(idx, 1);
        this._renderLevel(f, node, container, path);
      });
      card.appendChild(header);

      if (node.depth === 1) {
        const row = document.createElement('div');
        row.className = 'nested-unit-row';
        child.values.forEach((_, unitIdx) => {
          const input = document.createElement('input');
          input.type = 'number';
          input.step = 'any';
          input.className = 'nested-unit-input';
          input.placeholder = f.unitSize > 1 ? 'value ' + (unitIdx + 1) : 'value';
          input.value = child.values[unitIdx] ?? '';
          input.addEventListener('input', (ev) => {
            child.values[unitIdx] = ev.target.value === '' ? null : parseFloat(ev.target.value);
          });
          row.appendChild(input);
        });
        card.appendChild(row);
      } else {
        const sub = document.createElement('div');
        sub.className = 'nested-sublevel';
        card.appendChild(sub);
        this._renderLevel(f, child, sub, path.concat(idx));
      }
      container.appendChild(card);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn-add';
    addBtn.textContent = 'Add ' + label;
    addBtn.addEventListener('click', () => {
      node.children.push(node.depth === 1 ? { values: new Array(f.unitSize).fill(null) } : this._emptyNode(node.depth - 1));
      this._renderLevel(f, node, container, path);
    });
    container.appendChild(addBtn);
  }

  // Converts the tree into plain nested arrays matching the schema's own nesting —
  // depth levels of arrays, the innermost being each unit's `unitSize` numbers.
  _collectNode(node) {
    if (node.depth === 1) return node.children.map(child => child.values.slice());
    return node.children.map(child => this._collectNode(child));
  }

  collectValue(fieldName) {
    return this._collectNode(this.trees.get(fieldName));
  }

  // Valid when every field has at least one entry at every level, and every leaf unit
  // has all `unitSize` values filled in — mirrors geoFieldEngine's own validate().
  validate() {
    let valid = true;
    this.fields.forEach(f => {
      const errEl = document.getElementById('nestedErr_' + f.varName);
      const node = this.trees.get(f.name);
      const ok = this._nodeHasCompleteData(node);
      if (errEl) errEl.style.display = ok ? 'none' : 'block';
      if (!ok) valid = false;
    });
    return valid;
  }

  _nodeHasCompleteData(node) {
    if (node.children.length === 0) return false;
    if (node.depth === 1) return node.children.every(child => child.values.every(v => v !== null && !isNaN(v)));
    return node.children.every(child => this._nodeHasCompleteData(child));
  }
}

function initNestedArrayFields(fields) {
  if (!fields || fields.length === 0) return;
  window.__nestedArrayEngine = new NestedArrayEngine(fields);
}

// NOTE: no initNestedArrayFields(...) call at the bottom of this file — the field
// descriptors only exist in Node at generation time. lib/render/nestedArrayRenderer.js
// appends `initNestedArrayFields(${JSON.stringify(fields)})` itself, after reading
// this file's text (same pattern as lib/render/geoFieldEngine.js).
