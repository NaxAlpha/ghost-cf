const { normalizeBinding } = require('./d1-client.cjs');

// SQLite's JSON extraction preserves scalar types. Referencing one numbered
// parameter avoids the Workers limit while retaining one atomic SQL statement.
function compactBindings(sql, values) {
  const bindings = values.map(normalizeBinding);
  if (bindings.length <= 100) return { sql, bindings };
  const scalars = [];
  const binary = [];
  const references = bindings.map((value) => {
    if (value instanceof ArrayBuffer || (typeof value === 'number' && !Number.isFinite(value))) {
      binary.push(value);
      return `?${binary.length + 1}`;
    }
    scalars.push(value);
    return `json_extract(?1, '$[${scalars.length - 1}]')`;
  });
  if (binary.length >= 100) throw new RangeError('Too many direct SQLite bindings');
  let output = '';
  let bindingIndex = 0;
  let quote;
  let comment;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const next = sql[index + 1];
    if (comment) {
      output += char;
      if (comment === 'line' && char === '\n') comment = undefined;
      if (comment === 'block' && char === '*' && next === '/') {
        output += next;
        index++;
        comment = undefined;
      }
    } else if (quote) {
      output += char;
      if (char === quote) {
        if (next === quote && quote !== ']') {
          output += next;
          index++;
        } else quote = undefined;
      }
    } else if (char === "'" || char === '"' || char === '`' || char === '[') {
      quote = char === '[' ? ']' : char;
      output += char;
    } else if ((char === '-' && next === '-') || (char === '/' && next === '*')) {
      comment = char === '-' ? 'line' : 'block';
      output += char + next;
      index++;
    } else if (char === '?') {
      if (/\d/.test(next || '')) throw new Error('Numbered input bindings cannot be compacted');
      if (bindingIndex >= references.length) throw new Error('SQLite binding count mismatch');
      output += references[bindingIndex++];
    } else output += char;
  }
  if (bindingIndex !== references.length) throw new Error('SQLite binding count mismatch');
  return { sql: output, bindings: [JSON.stringify(scalars), ...binary] };
}

module.exports = { compactBindings };
