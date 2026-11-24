// Definisce il piccolo linguaggio di espressioni sicuro usato da data-extra-valid:
// una grammatica fissa (mai JavaScript/eval) parsata da jsep e percorsa da evalExprNode.
// Pipeline: stessa sorgente usata server-side da sanitizeLlmOutput.js e iniettata client-side da formEngine.js, così le due non possono mai divergere.

const ALLOWED_NODE_TYPES = new Set([
  'BinaryExpression', 'LogicalExpression', 'UnaryExpression', 'Literal', 'Identifier', 'CallExpression',
]);

const ALLOWED_IDENTIFIERS = new Set(['value', 'now']);

// name -> arity. All pure functions of their arguments only — no closures over the
// page, DOM, clock or network (the one exception, "now", is injected as data by the
// engine itself, never read by a function call).
const ALLOWED_CALLS = {
  min: 2, max: 2, abs: 1, round: 1, floor: 1, ceil: 1,
  len: 1, includes: 2, startsWith: 2, endsWith: 2, lower: 1, upper: 1,
  daysUntil: 1, daysSince: 1, // date-string argument -> whole days from/to `now`
};

// Walks a jsep AST node and throws on the first thing outside ALLOWED_*. Used
// server-side to reject an LLM field before it's ever shipped to a browser.
function assertSafeExprNode(node, exprForError) {
  if (!ALLOWED_NODE_TYPES.has(node.type)) {
    throw new Error(`Disallowed expression node "${node.type}" in data-extra-valid="${exprForError}"`);
  }
  if (node.type === 'Identifier' && !ALLOWED_IDENTIFIERS.has(node.name)) {
    throw new Error(`Disallowed identifier "${node.name}" in data-extra-valid="${exprForError}"`);
  }
  if (node.type === 'CallExpression') {
    const calleeName = node.callee && node.callee.type === 'Identifier' ? node.callee.name : null;
    const arity = calleeName && ALLOWED_CALLS[calleeName];
    if (!arity) {
      throw new Error(`Disallowed function call "${calleeName || '?'}" in data-extra-valid="${exprForError}"`);
    }
    if (node.arguments.length !== arity) {
      throw new Error(`"${calleeName}" expects ${arity} argument(s) in data-extra-valid="${exprForError}"`);
    }
    node.arguments.forEach(arg => assertSafeExprNode(arg, exprForError));
    return;
  }
  for (const key of ['left', 'right', 'argument']) {
    if (node[key]) assertSafeExprNode(node[key], exprForError);
  }
}

// The interpreter's function table. Pure JS, no I/O — same list as ALLOWED_CALLS.
const CALL_IMPLS = {
  min: (a, b) => Math.min(a, b),
  max: (a, b) => Math.max(a, b),
  abs: (a) => Math.abs(a),
  round: (a) => Math.round(a),
  floor: (a) => Math.floor(a),
  ceil: (a) => Math.ceil(a),
  len: (a) => (a == null ? 0 : a.length),
  includes: (a, b) => String(a).includes(b),
  startsWith: (a, b) => String(a).startsWith(b),
  endsWith: (a, b) => String(a).endsWith(b),
  lower: (a) => String(a).toLowerCase(),
  upper: (a) => String(a).toUpperCase(),
  daysUntil: (a, scope) => Math.floor((Date.parse(a) - scope.now) / 86400000),
  daysSince: (a, scope) => Math.floor((scope.now - Date.parse(a)) / 86400000),
};

// Evaluates a jsep AST node against `scope` ({ value, now }). Assumes the node has
// already passed assertSafeExprNode — this never falls back to eval/Function, so an
// unexpected node type simply throws rather than silently doing something unsafe.
function evalExprNode(node, scope) {
  switch (node.type) {
    case 'Literal': return node.value;
    case 'Identifier':
      if (!(node.name in scope)) throw new Error(`Unknown identifier "${node.name}"`);
      return scope[node.name];
    case 'UnaryExpression': {
      const arg = evalExprNode(node.argument, scope);
      if (node.operator === '!') return !arg;
      if (node.operator === '-') return -arg;
      if (node.operator === '+') return +arg;
      throw new Error(`Unsupported unary operator "${node.operator}"`);
    }
    case 'BinaryExpression': {
      const l = evalExprNode(node.left, scope);
      const r = evalExprNode(node.right, scope);
      switch (node.operator) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
        case '%': return l % r;
        case '<': return l < r;
        case '<=': return l <= r;
        case '>': return l > r;
        case '>=': return l >= r;
        case '==': return l == r;
        case '!=': return l != r;
        case '===': return l === r;
        case '!==': return l !== r;
        default: throw new Error(`Unsupported binary operator "${node.operator}"`);
      }
    }
    case 'LogicalExpression': {
      if (node.operator === '&&') return evalExprNode(node.left, scope) && evalExprNode(node.right, scope);
      if (node.operator === '||') return evalExprNode(node.left, scope) || evalExprNode(node.right, scope);
      throw new Error(`Unsupported logical operator "${node.operator}"`);
    }
    case 'CallExpression': {
      const name = node.callee.name;
      if (!(name in CALL_IMPLS)) throw new Error(`Unknown function "${name}"`);
      const args = node.arguments.map(a => evalExprNode(a, scope));
      return CALL_IMPLS[name](...args, scope);
    }
    default:
      throw new Error(`Unsupported expression node "${node.type}"`);
  }
}

module.exports = {
  ALLOWED_NODE_TYPES, ALLOWED_IDENTIFIERS, ALLOWED_CALLS,
  assertSafeExprNode, evalExprNode,
};
