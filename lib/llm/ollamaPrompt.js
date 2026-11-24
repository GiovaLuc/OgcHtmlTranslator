// Costruisce il prompt per un campo scalare non supportato a partire da blocchi di
// regole componibili: un blocco base fisso più solo il blocco specifico che corrisponde
// alla forma dello schema del campo.
// Pipeline: chiamato da ollamaRenderer.js per i campi non-geo; i campi con forma geo usano invece ollamaGeoPrompt.js.

const BASE_BLOCK = `You translate ONE field of an OGC process into HTML. You will receive that field's own
JSON definition (name, title, description, minOccurs, maxOccurs, schema) and must respond with
ONLY the HTML for that field — no JSON, no markdown code fences, no explanation, no <script> tags.

Always use exactly this structure and these existing CSS classes (never invent new classes or
inline styles):

<div class="section">
<div class="section-title">TITLE[ + optional-badge if not required]</div>
<p class="hint">DESCRIPTION</p>
CONTROL
<span class="error-msg" id="NAMEErr">Invalid value.</span>
</div>

Rules:
- NAME is always the field's own given name, used as-is for the control's \`name\` and \`id\` and
for the \`NAMEErr\` error span id. Never invent or alter it.
- Add \`<span class="optional-badge">optional</span>\` right after the title text ONLY if
minOccurs is 0 or absent. Add the HTML \`required\` attribute on the control ONLY if
minOccurs >= 1. Never both, never neither.
- Never invent constraints, defaults, options, or attributes beyond the schema/description.
A field with no minimum/maximum/minLength/maxLength/pattern in its schema and no explicit
extra rule in its description gets NO min/max/minlength/pattern/data-extra-valid at all —
resist the urge to add a "sensible" one (e.g. never add ">= 0" to a number, or a minimum
length to a string, unless the schema or description actually says so). Never set \`checked\`,
\`value\`, or \`selected\` unless the schema declares a "default". Never use template placeholder
syntax such as {{ }} or \${ }.
- Never add <script> tags, inline event handlers (onclick/oninput/...), or DOM calls like
document.getElementById/querySelector: reading values, the empty check, and error display are
handled once, globally, by page code that already knows every field's name.
- Respond with ONLY the <div class="section">...</div> block for this one field. Nothing else.`;

const EXTRA_VALID_BLOCK = `- data-extra-valid is RARE. Add it ONLY if the description states an extra constraint in
words, AND no native HTML5 attribute (min/max/step/pattern/minlength/maxlength) nor the
choice of control itself already enforces it. In particular: a select/radio/checkbox
whose options ARE the schema's enum values already can't produce anything else — never
add data-extra-valid to one just to "double check" the value is one of its own options.
If the description says nothing beyond what the schema/title already state, add NO
data-extra-valid at all.
When you do need it: EXPR is NOT JavaScript — it's a small safe expression language:
comparison/arithmetic/boolean operators, literals, the bare identifiers \`value\` (the
field's own current value) and \`now\` (current time in ms, only meaningful for date/time
fields), and these pure functions only:
min(a,b) max(a,b) abs(a) round(a) floor(a) ceil(a) len(a) includes(a,b) startsWith(a,b)
endsWith(a,b) lower(a) upper(a) daysUntil(dateStr) daysSince(dateStr). No other
identifiers or function names are recognized — never use the field's own name as an
identifier, always \`value\`. TRUE means the value SATISFIES the constraint (the valid
case, never the error case — a shared page script negates it automatically for every
field). Example: "must not be in the future" on a date field ->
data-extra-valid="daysUntil(value) >= 0".`;

const ENUM_BLOCK = `- This field's schema has a fixed "enum" list. Use a <select> (multiple if the field is
repeatable) with one <option value="..."> per enum value, or radio inputs sharing the
field's name if there are very few options — never a free-text input. The option values
must be exactly the enum's own values, nothing added or removed.
${EXTRA_VALID_BLOCK}`;

const STRING_DATE_BLOCK = `- Choose the control from the schema: plain "string" -> type="text"; map "format" to the
matching native input type when present (date -> type="date", date-time ->
type="datetime-local", time -> type="time", email -> type="email", uri -> type="url").
Use native HTML5 attributes for everything they can express: min, max, pattern, minlength,
maxlength. Never write custom JavaScript for something a native attribute already covers.
${EXTRA_VALID_BLOCK}`;

const NUMBER_BLOCK = `- Choose type="number". If the schema type is "integer", always add step="1" (in addition
to type="number") so the browser itself rejects decimal input — never rely on
data-extra-valid for that. If the schema type is "number" (not "integer"), use step="any"
instead — never step="1" on a number field, that would wrongly reject decimals. Use min/max
from the schema's minimum/maximum if present.
${EXTRA_VALID_BLOCK}`;

const BOOLEAN_BLOCK = `- Choose <input type="checkbox">. A boolean field has no min/max/pattern — never add any.
${EXTRA_VALID_BLOCK}`;

const ARRAY_BLOCK = `- This field's schema is an "array" of scalar items with no enum. Use a <select multiple>
of the item type's own control, or (if that's impractical for the item type) a single
text input the shared page script reads as a comma-separated list — never invent per-item
add/remove JavaScript, that is handled by page code, not by this block.
${EXTRA_VALID_BLOCK}`;

// One worked example per topic keeps the (very small) local model anchored to the
// exact output shape without inflating the prompt with every block's own example.
const WORKED_EXAMPLE = `Already-solved example (follow this format EXACTLY):

Field:
name: consent_given
{
"title": "Terms Acceptance",
"description": "Confirm you accept the terms of service. Must be checked to proceed.",
"minOccurs": 1,
"maxOccurs": 1,
"schema": { "type": "boolean" }
}

Correct output:
<div class="section">
<div class="section-title">Terms Acceptance</div>
<p class="hint">Confirm you accept the terms of service. Must be checked to proceed.</p>
<input type="checkbox" name="consent_given" id="consent_given" required data-extra-valid="value === true">
<span class="error-msg" id="consent_givenErr">Invalid value.</span>
</div>

Note: no "checked" attribute (the schema declares no default). data-extra-valid expresses the
VALID case ("checked"), not the invalid one — the shared script negates it.`;

// Picks which topic blocks apply to this field's schema shape. A field can match more
// than one loosely (e.g. a string with an enum): enum takes priority since it replaces
// the control choice entirely, the others are mutually exclusive by JSON Schema "type".
function selectBlocksForSchema(schema) {
  const blocks = [BASE_BLOCK];
  if (!schema) return blocks;

  if (Array.isArray(schema.enum)) {
    blocks.push(ENUM_BLOCK);
  } else if (schema.type === 'string') {
    blocks.push(STRING_DATE_BLOCK);
  } else if (schema.type === 'number' || schema.type === 'integer') {
    blocks.push(NUMBER_BLOCK);
  } else if (schema.type === 'boolean') {
    blocks.push(BOOLEAN_BLOCK);
  } else if (schema.type === 'array') {
    blocks.push(ARRAY_BLOCK);
  } else {
    // Unrecognized shape (e.g. a plain object with no enum): fall back to every
    // topic block so the model still has the full rule set to work from.
    blocks.push(ENUM_BLOCK, STRING_DATE_BLOCK, NUMBER_BLOCK, BOOLEAN_BLOCK, ARRAY_BLOCK);
  }
  blocks.push(WORKED_EXAMPLE);
  return blocks;
}

// `process` carries id/title (for context) and the other field names already known
// in the same form, so the model understands it's producing one piece of a bigger
// page rather than a standalone document.
function buildOllamaPrompt(name, def, process, otherFieldNames) {
  const fieldJson = JSON.stringify({
    title: def.title,
    description: def.description,
    minOccurs: def.minOccurs,
    maxOccurs: def.maxOccurs,
    schema: def.schema,
  }, null, 2);

  const contextLine = otherFieldNames.length
    ? `\n\nContext: this field is part of the same form as the "${process.id}" process, along with ${otherFieldNames.map(n => `"${n}"`).join(', ')} already handled separately.`
    : '';

  const rules = selectBlocksForSchema(def.schema).join('\n\n');

  return `${rules}

Field to translate:
name: ${name}
${fieldJson}${contextLine}`;
}

module.exports = { buildOllamaPrompt, selectBlocksForSchema };
