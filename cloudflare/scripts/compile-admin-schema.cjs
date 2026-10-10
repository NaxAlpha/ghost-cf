const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function compileAdminSchemas(root, output) {
  const releaseRequire = createRequire(path.join(root, 'package.json'));
  const { Ajv } = releaseRequire('ajv');
  const { _ } = releaseRequire('ajv/dist/compile/codegen');
  const standaloneCode = releaseRequire('ajv/dist/standalone').default;
  const addFormats = releaseRequire('ajv-formats');
  const formatsFile = path.join(output, 'ghost-admin-formats.cjs');
  fs.writeFileSync(
    formatsFile,
    'module.exports={...require(' +
      JSON.stringify(releaseRequire.resolve('ajv-formats/dist/formats')) +
      ').fullFormats,"json-string":{type:"string",validate:(data)=>{try{JSON.parse(data);return true;}catch{return false;}}}};',
  );
  const ajv = new Ajv({
    allErrors: true,
    useDefaults: true,
    removeAdditional: true,
    code: { source: true, formats: _`require(${formatsFile})` },
  });
  addFormats(ajv);
  ajv.addFormat('json-string', {
    type: 'string',
    validate: (data) => {
      try {
        JSON.parse(data);
        return true;
      } catch {
        return false;
      }
    },
  });
  // Equivalent to Ghost's keyword; emitting it at build time avoids runtime eval.
  ajv.addKeyword({
    keyword: 'isLowercase',
    type: 'string',
    schemaType: 'boolean',
    errors: false,
    code(context) {
      context.fail(_`${context.data} !== ${context.data}.toLowerCase()`);
    },
  });
  const directory = path.join(root, 'node_modules/@tryghost/admin-api-schema/build/schemas');
  const schemas = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')));
  const failures = {};
  for (const schema of schemas) {
    try {
      ajv.addSchema(schema);
    } catch (error) {
      failures[schema.$id] = error.message;
      ajv.removeSchema(schema.$id);
    }
  }
  for (const schema of schemas) {
    if (!failures[schema.$id])
      try {
        ajv.getSchema(schema.$id);
      } catch (error) {
        failures[schema.$id] = error.message;
      }
  }
  if (Object.keys(failures).length)
    console.warn('Upstream schemas that already fail AJV validation:', Object.keys(failures));
  const names = Object.fromEntries(
    schemas.flatMap((schema, index) => (failures[schema.$id] ? [] : [['v' + index, schema.$id]])),
  );
  const compiled = path.join(output, 'ghost-admin-validators.cjs');
  fs.writeFileSync(compiled, standaloneCode(ajv, names));
  const registry = path.join(output, 'ghost-admin-validator-registry.cjs');
  fs.writeFileSync(
    registry,
    'const validators=require(' +
      JSON.stringify(compiled) +
      ');module.exports={' +
      schemas
        .map(
          (schema, index) =>
            JSON.stringify(schema.$id) +
            ':' +
            (failures[schema.$id]
              ? '()=>{throw new Error(' + JSON.stringify(failures[schema.$id]) + ')}'
              : 'validators.v' + index),
        )
        .join(',') +
      '};',
  );
  return registry;
}
module.exports = { compileAdminSchemas };
