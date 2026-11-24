// Valida la classificazione { role, wrapper, requiredProp } prodotta da
// ollamaGeoPrompt.js contro lo schema del campo, lanciando un errore per ciò che lo
// contraddice — incluso il caso role:"unrecognized" (il modello dichiara onestamente
// che nessuna categoria nota si adatta, invece di forzarne una sbagliata).
// Pipeline: chiamato da ollamaRenderer.js subito dopo la risposta del modello; un errore qui instrada il campo al fallback textarea JSON grezzo invece che a un ruolo mappa non verificato.
const { findRequiredProps, isRepeatable } = require('./geoSchemaHeuristics');

const ROLES = new Set(['single', 'union', 'contained', 'unrecognized']);
const WRAPPERS = new Set(['raw-geometry', 'feature', 'featurecollection', 'feature-array']);
// The only tools leaflet-draw actually implements — any drawTools entry outside this
// set can't be rendered, so it's dropped rather than failing the whole classification
// (the drawn-shape tool is a usability nicety, not load-bearing like role/wrapper).
const DRAW_TOOLS = new Set(['marker', 'polyline', 'polygon', 'rectangle', 'circle']);
const DEFAULT_DRAW_TOOLS = ['polygon', 'rectangle', 'circle'];

// Scans forward from the first "{" and tracks brace depth (ignoring braces inside
// string literals) to find that object's own matching "}" — unlike a greedy regex,
// this never swallows unrelated braces the model wrote later in its own prose (e.g.
// an example object mentioned while reasoning, before the real answer).
function extractBalancedObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (inString) {
      if (ch === '\\') escapeNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

// Collects every top-level balanced "{...}" object in the text (there can be more
// than one: a model reasoning in prose sometimes mentions an unrelated object, like
// an example schema snippet, before writing the real answer).
function findAllBalancedObjects(text) {
  const found = [];
  let from = 0;
  while (true) {
    const brace = text.indexOf('{', from);
    if (brace === -1) break;
    const balanced = extractBalancedObject(text, brace);
    if (balanced) {
      found.push(balanced);
      from = brace + balanced.length;
    } else {
      from = brace + 1;
    }
  }
  return found;
}

// Models asked for a bare JSON object sometimes wrap it in prose and/or a markdown
// fence despite instructions not to, and occasionally mention an unrelated "{...}"
// (e.g. an example) while reasoning before the real answer. Tries, in order: (1) a
// ```json fenced block — the clearest signal of intentional output when the model
// adds commentary around it; (2) among every balanced "{...}" object in the text,
// the first one that actually parses as JSON AND has a "role" key — the one shape
// only the real answer has, distinguishing it from an incidental object mentioned in
// prose; (3) the old greedy first-to-last-brace match, kept as a last resort.
function extractJsonObjectText(rawText) {
  const fenced = rawText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fenced) return fenced[1];

  for (const candidate of findAllBalancedObjects(rawText)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && 'role' in parsed) return candidate;
    } catch (e) { /* not valid JSON on its own, e.g. a prose fragment like {"type": "object"} mid-sentence — try the next candidate */ }
  }

  const greedy = rawText.match(/\{[\s\S]*\}/);
  return greedy ? greedy[0] : null;
}

// Validates one requiredProp entry: { key, type, inferred, reason? }. Entries with
// inferred:false are checked against the schema's own declared properties (same as
// before — never trust the model over structure it could have read directly).
// Entries with inferred:true can't be checked structurally by definition (they come
// from free-text description, which has no fixed grammar) — they're accepted on
// shape alone, but MUST carry a non-empty "reason" so a human reviewing the
// generated page can see why the model added a property the schema never declared.
function validateRequiredPropEntry(name, entry, schemaProps) {
  if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string') {
    throw new Error(`Field "${name}": requiredProp entry is not a valid {key, type, inferred} object: ${JSON.stringify(entry)}`);
  }
  if (entry.type !== 'number' && entry.type !== 'integer') {
    throw new Error(`Field "${name}": requiredProp "${entry.key}" has invalid type "${entry.type}"`);
  }
  if (entry.inferred === true) {
    if (!entry.reason || typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`Field "${name}": requiredProp "${entry.key}" is marked inferred but has no "reason"`);
    }
    return { key: entry.key, type: entry.type, inferred: true, reason: entry.reason };
  }
  const schemaEntry = schemaProps.find(p => p.key === entry.key);
  if (!schemaEntry) {
    throw new Error(`Field "${name}": requiredProp "${entry.key}" claims inferred:false but isn't in the schema's own "required" list — mark it inferred:true with a reason instead`);
  }
  if (schemaEntry.type !== entry.type) {
    throw new Error(`Field "${name}": requiredProp "${entry.key}" type "${entry.type}" does not match schema's own type "${schemaEntry.type}"`);
  }
  return { ...schemaEntry, inferred: false };
}

// Finds the deepest bare number[] array nested inside the schema's own properties —
// the same shape hasUnresolvableNestedArrayShape (ollamaGeoPrompt.js) looks for when
// picking an example — and returns how many "array of" levels wrap it. Structural
// fact derived straight from the schema, used to check the model's own claimed
// nestingDepth rather than trust free text about it.
function findDeepestNumberArrayDepth(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties) return 0;
  let best = 0;
  for (const prop of Object.values(schema.properties)) {
    let depth = 0;
    let cur = prop;
    while (cur && cur.type === 'array' && cur.items) { depth++; cur = cur.items; }
    if (depth >= 2 && cur && cur.type === 'number') best = Math.max(best, depth);
  }
  return best;
}

// Validates the optional nestedArrayShape the model may attach to an "unrecognized"
// classification (see ollamaGeoPrompt.js). Unlike requiredProp, there's no schema-only
// way to derive unitSize/labels (the schema never says "pairs" or names a level) — those
// come from the description and are trusted on shape alone, but nestingDepth itself MUST
// match the schema's own structure, the one part that's actually verifiable.
function validateNestedArrayShape(name, shape, schema) {
  if (!shape || typeof shape !== 'object') return null;
  const { nestingDepth, unitSize, labels } = shape;
  if (!Number.isInteger(nestingDepth) || nestingDepth < 1) return null;
  if (!Number.isInteger(unitSize) || unitSize < 1) return null;
  if (!Array.isArray(labels) || labels.length !== nestingDepth || !labels.every(l => typeof l === 'string' && l.trim() !== '')) {
    return null;
  }
  const actualDepth = findDeepestNumberArrayDepth(schema);
  if (actualDepth === 0 || actualDepth !== nestingDepth) return null;
  return { nestingDepth, unitSize, labels };
}

// Keeps only the tools leaflet-draw can actually render, deduplicated, in the
// model's own order; falls back to the permissive polygon/rectangle/circle set
// when the model didn't provide a usable list (missing, not an array, empty, or
// every entry outside DRAW_TOOLS) — never fails the field over this alone, since
// the field's role/wrapper/data shape are already validated independently of it.
function validateDrawTools(drawTools) {
  if (!Array.isArray(drawTools)) return DEFAULT_DRAW_TOOLS;
  const valid = [...new Set(drawTools.filter(t => DRAW_TOOLS.has(t)))];
  return valid.length > 0 ? valid : DEFAULT_DRAW_TOOLS;
}

// Falls back to a safe, always-renderable classification when the model's own
// role/wrapper/requiredProp choice can't be trusted, but keeps whatever drawTools
// it gave us (validated independently, see validateDrawTools) — losing the map's
// draw-tool selection over an unrelated role mistake would throw away the one part
// of the answer this phase is actually trying to improve.
function fallbackClassification(drawTools) {
  return { role: 'single', wrapper: 'raw-geometry', requiredProp: [], drawTools: validateDrawTools(drawTools) };
}

function sanitizeLlmGeoField(name, rawText, def) {
  const schema = def.schema;
  let parsed;
  try {
    const objectText = extractJsonObjectText(rawText);
    if (!objectText) throw new Error('no JSON object found');
    parsed = JSON.parse(objectText);
  } catch (e) {
    throw new Error(`Field "${name}": unparsable geo classification: ${e.message}`);
  }

  const { role, wrapper, requiredProp, drawTools, reason, nestedArrayShape } = parsed;

  // "unrecognized" is the model's honest escape hatch when no role/wrapper fits —
  // skips every other check (wrapper/requiredProp are meaningless placeholders in
  // this case). If it also attached a valid nestedArrayShape, return a "nested-array"
  // classification instead of throwing — the caller (generateHtml.js) can build a
  // plain nested-list editor from it instead of degrading straight to a raw JSON
  // textarea. Without one (or with an invalid one), still throws like before: the
  // caller degrades to the raw-JSON textarea instead of forcing a wrong classification
  // into the map renderer.
  if (role === 'unrecognized') {
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`Field "${name}": role "unrecognized" requires a non-empty "reason"`);
    }
    const shape = validateNestedArrayShape(name, nestedArrayShape, schema);
    if (shape) {
      return { role: 'nested-array', wrapper: 'raw-geometry', requiredProp: [], drawTools: [], nestedArrayShape: shape, reason };
    }
    throw new Error(`Field "${name}": model declared this field unrecognized: ${reason}`);
  }

  const maxOccurs = def.maxOccurs;
  const schemaProps = findRequiredProps(schema);

  // A schema-declared required property forces "contained" — a structural fact,
  // derived exactly like classifyField does for the static kinds, never something
  // the model could legitimately get to choose.
  if (schemaProps.length > 0 && role !== 'contained') {
    throw new Error(`Field "${name}": schema has required per-shape properties but role is "${role}", expected "contained"`);
  }

  if (!ROLES.has(role) || !WRAPPERS.has(wrapper) || !Array.isArray(requiredProp)) {
    return fallbackClassification(drawTools);
  }
  if (!isRepeatable(maxOccurs) && role === 'union') {
    return fallbackClassification(drawTools);
  }

  // schemaProps.length > 0 forces role==="contained" (checked above) — that path
  // MUST throw on failure rather than degrade: silently falling back to "single"
  // would drop per-shape properties the schema itself says are required. Every
  // other combination below is the model's own free choice, so a mistake there is
  // safe to degrade instead of losing drawTools over it.
  if (schemaProps.length > 0) {
    if (requiredProp.length === 0) {
      throw new Error(`Field "${name}": role "contained" requires at least one requiredProp entry`);
    }
    const validatedProps = requiredProp.map(entry => validateRequiredPropEntry(name, entry, schemaProps));
    const coveredKeys = new Set(validatedProps.map(p => p.key));
    const missing = schemaProps.filter(p => !coveredKeys.has(p.key));
    if (missing.length > 0) {
      throw new Error(`Field "${name}": requiredProp is missing schema-required propert${missing.length === 1 ? 'y' : 'ies'} ${missing.map(p => p.key).join(', ')}`);
    }
    if (wrapper !== 'featurecollection' && wrapper !== 'feature-array') {
      throw new Error(`Field "${name}": role "contained" must use wrapper "featurecollection" or "feature-array", got "${wrapper}"`);
    }
    return { role, wrapper, requiredProp: validatedProps, drawTools: validateDrawTools(drawTools) };
  }

  let validatedProps = [];
  try {
    if (role === 'contained') {
      if (requiredProp.length === 0) {
        throw new Error(`Field "${name}": role "contained" requires at least one requiredProp entry`);
      }
      validatedProps = requiredProp.map(entry => validateRequiredPropEntry(name, entry, schemaProps));
      if (wrapper !== 'featurecollection' && wrapper !== 'feature-array') {
        throw new Error(`Field "${name}": role "contained" must use wrapper "featurecollection" or "feature-array", got "${wrapper}"`);
      }
    } else if (requiredProp.length > 0) {
      throw new Error(`Field "${name}": role "${role}" must have an empty requiredProp`);
    }

    if (role === 'union' && wrapper === 'feature-array') {
      throw new Error(`Field "${name}": role "union" cannot use wrapper "feature-array" (no per-shape properties to keep distinct)`);
    }
    if (role === 'single' && (wrapper === 'featurecollection' || wrapper === 'feature-array')) {
      throw new Error(`Field "${name}": role "single" cannot use a multi-shape wrapper "${wrapper}"`);
    }
  } catch (e) {
    // Reached only when schemaProps is empty (see the early return above), so
    // "contained" here is the model's own unforced choice — degrading instead of
    // throwing is safe: there's no schema-required property being silently dropped.
    return fallbackClassification(drawTools);
  }

  return {
    role,
    wrapper,
    requiredProp: validatedProps,
    drawTools: validateDrawTools(drawTools),
  };
}

module.exports = { sanitizeLlmGeoField };
