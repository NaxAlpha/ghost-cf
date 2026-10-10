const { test } = require('node:test');
const assert = require('node:assert/strict');
const handlebars = require('handlebars');
const { compile } = require('../src/template-interpreter.cjs');

test('interprets uploaded templates with the same helpers, context, escaping, and partials', () => {
  const env = handlebars.create();
  env.registerPartial('card', '[{{name}}]');
  env.registerPartial('layout', '<main>{{> @partial-block}}</main>');
  env.registerHelper('join', (first, second) => first + second);
  env.registerHelper('safe', () => new env.SafeString('<b>safe</b>'));
  const context = {
    title: 'Title',
    name: '<&>',
    people: [{ name: 'Alice' }, { name: 'Bob' }],
    person: { name: 'Chris' },
    empty: [],
  };
  const cases = [
    'Hello {{name}} / {{{name}}} / {{safe}}',
    '{{#each people as |person index|}}{{index}}:{{person.name}}/{{../title}}/{{@root.title}};{{else}}empty{{/each}}',
    '{{#each empty}}unexpected{{/each}}',
    '{{#if missing}}unexpected{{/if}}',
    '{{#unless missing}}expected{{else}}unexpected{{/unless}}',
    '{{#with person}}{{name}}:{{../title}}{{/with}}',
    '{{join (join "a" "b") "c"}}',
    '{{> card person}}',
    '{{> card name="override"}}',
    '{{#> layout}}inside {{title}}{{/layout}}',
    '{{#*inline "local"}}local {{name}}{{/inline}}{{> local person}}',
    'before\n  {{> card person}}\nafter',
    '{{#people}}{{name}}{{/people}}',
    '{{!comment}}{{~name~}}',
    '{{lookup person "name"}}',
  ];
  for (const source of cases) {
    assert.equal(compile(source, {}, env)(context), env.compile(source)(context), source);
  }
});

test('does not generate JavaScript or expose inherited properties', () => {
  const env = handlebars.create();
  const template = compile('{{value}}/{{constructor}}/{{nested.secret}}', {}, env);
  const context = Object.assign(Object.create({ value: 'hidden' }), {
    nested: Object.create({ secret: 'hidden' }),
  });
  assert.equal(template(context), '//');
  assert.throws(
    () => compile('{{> constructor}}', {}, env)({}),
    /partial constructor could not be found/,
  );
  assert.throws(
    () => compile('{{missing}}', { strict: true }, env)({}),
    /Missing template property/,
  );
  const originalFunction = global.Function;
  try {
    global.Function = () => {
      throw new Error('Runtime code generation disabled');
    };
    assert.equal(compile('Hello {{name}}', {}, env)({ name: 'Worker' }), 'Hello Worker');
  } finally {
    global.Function = originalFunction;
  }
});
