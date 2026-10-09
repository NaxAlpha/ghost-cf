const fs = require('node:fs/promises');
const path = require('node:path');
const Handlebars = require('handlebars');

async function collect(directory, prefix = '') {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory())
      files.push(...(await collect(path.join(directory, entry.name), relative)));
    else if (entry.isFile() && entry.name.endsWith('.hbs')) files.push(relative);
  }
  return files.sort();
}

async function precompileTheme(directory, output) {
  const templates = [];
  const partials = [];
  for (const relative of await collect(directory)) {
    const source = await fs.readFile(path.join(directory, relative), 'utf8');
    const compiled = Handlebars.precompile(source);
    const name = relative.replace(/\.hbs$/, '');
    const record = `${JSON.stringify(name.replace(/^partials\//, ''))}: Handlebars.template(${compiled})`;
    (name.startsWith('partials/') ? partials : templates).push(record);
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(
    output,
    [
      '// Generated at build time. Do not compile templates inside a request.',
      "import Handlebars from 'handlebars/runtime.js';",
      `export const templates = {${templates.join(',\n')}};`,
      `export const partials = {${partials.join(',\n')}};`,
      'export function registerPartials() { Handlebars.registerPartial(partials); }',
      '',
    ].join('\n'),
  );
  return { templates: templates.length, partials: partials.length };
}

module.exports = { precompileTheme };

if (require.main === module) {
  const [directory, output] = process.argv.slice(2);
  if (!directory || !output) {
    console.error('Usage: pnpm themes:compile <theme-directory> <output.mjs>');
    process.exitCode = 1;
  } else {
    precompileTheme(directory, output)
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
