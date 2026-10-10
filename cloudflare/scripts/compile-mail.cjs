const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');

function compileMailTemplates(releaseRoot, outputRoot) {
  const lodashPath = createRequire(path.join(releaseRoot, 'package.json')).resolve('lodash');
  const lodash = require(lodashPath).runInContext();
  lodash.templateSettings.interpolate = /{{([\s\S]+?)}}/g;
  const directory = path.join(releaseRoot, 'core/server/lib/mail/templates');
  const entries = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.html'))
    .map((name) => {
      const content = fs.readFileSync(path.join(directory, name), 'utf8');
      const key = createHash('sha256').update(content).digest('hex');
      // Explicit scope avoids Lodash's `with` statement, which ESM forbids.
      // Fail on newly introduced template expressions instead of miscompiling them.
      if (/<%/.test(content))
        throw new Error('Ghost mail template has unsupported evaluation: ' + name);
      const scoped = content.replace(/{{([\s\S]+?)}}/g, (_, expression) => {
        const field = expression.trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(field))
          throw new Error('Ghost mail template expression changed: ' + name);
        return '{{ data.' + field + ' }}';
      });
      return JSON.stringify(key) + ':' + lodash.template(scoped, { variable: 'data' }).source;
    });
  const target = path.join(outputRoot, 'ghost-mail-template-registry.cjs');
  fs.writeFileSync(
    target,
    'const _=require(' +
      JSON.stringify(lodashPath) +
      ');const templates={' +
      entries.join(',') +
      '};module.exports.compile=(content)=>{const key=require("node:crypto").createHash("sha256").update(content).digest("hex");if(!templates[key])throw new Error("Ghost mail template not linked; rebuild the release bundle");return templates[key];};',
  );
  return target;
}

module.exports = { compileMailTemplates };
