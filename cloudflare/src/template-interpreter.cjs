// Interpret Handlebars' parsed template AST. Uploaded templates are data;
// compiling them never executes generated JavaScript or uses request-time eval.
function compile(input, options, environment) {
  const ast = environment.parse(input, options);
  const lookupProperty = (object, name) => {
    if (object == null || !Object.prototype.hasOwnProperty.call(Object(object), name))
      return undefined;
    return object[name];
  };
  function resolve(node, frame) {
    if (!node) return undefined;
    if (node.type === 'SubExpression') return expression(node, frame);
    if (node.type !== 'PathExpression') return node.value;
    const parts = node.parts;
    let value;
    let offset = 0;
    if (node.data) {
      value = frame.data;
      for (let i = 0; i < node.depth; i++) value = value?._parent;
    } else if (!node.depth && parts.length && parts[0] in frame.aliases) {
      value = frame.aliases[parts[0]];
      offset = 1;
    } else {
      value = node.depth ? frame.parents[node.depth - 1] : frame.context;
    }
    for (const part of parts.slice(offset)) value = lookupProperty(value, part);
    if (value === undefined && options.strict)
      throw new Error(`Missing template property: ${node.original}`);
    return value;
  }
  function program(programNode, frame) {
    if (!programNode) return Object.assign(() => '', { blockParams: 0 });
    const fn = (context, invocation = {}) => {
      const aliases = Object.create(frame.aliases);
      for (let i = 0; i < (programNode.blockParams || []).length; i++) {
        aliases[programNode.blockParams[i]] = invocation.blockParams?.[i];
      }
      const parents = context === frame.context ? frame.parents : [frame.context, ...frame.parents];
      return render(programNode, {
        ...frame,
        context,
        parents,
        aliases,
        data: invocation.data || frame.data,
      });
    };
    fn.blockParams = programNode.blockParams?.length || 0;
    return fn;
  }
  function helperOptions(node, frame) {
    const hash = {};
    for (const pair of node.hash?.pairs || []) hash[pair.key] = resolve(pair.value, frame);
    return {
      name: node.path.original,
      hash,
      data: frame.data,
      loc: node.loc,
      lookupProperty,
      fn: program(node.program, frame),
      inverse: program(node.inverse, frame),
    };
  }
  function expression(node, frame) {
    const params = node.params.map((parameter) => resolve(parameter, frame));
    const name = node.path.original;
    const helper = !node.path.depth && !node.path.data && lookupProperty(frame.helpers, name);
    const invocation = helperOptions(node, frame);
    if (helper) return helper.call(frame.context, ...params, invocation);
    let value = resolve(node.path, frame);
    if (typeof value === 'function') value = value.call(frame.context, ...params, invocation);
    else if (params.length || node.hash?.pairs.length) {
      return frame.helpers.helperMissing.call(frame.context, ...params, invocation);
    }
    if (node.type === 'BlockStatement') {
      return frame.helpers.blockHelperMissing.call(frame.context, value, invocation);
    }
    return value;
  }
  function partial(node, frame) {
    const name =
      node.name.type === 'SubExpression' ? resolve(node.name, frame) : node.name.original;
    let implementation = lookupProperty(frame.partials, name);
    let context = node.params.length ? resolve(node.params[0], frame) : frame.context;
    const hash = {};
    for (const pair of node.hash?.pairs || []) hash[pair.key] = resolve(pair.value, frame);
    if (node.hash?.pairs.length) context = { ...context, ...hash };
    const partials = { ...frame.partials };
    if (node.program) {
      const previous = partials['@partial-block'];
      partials['@partial-block'] = (value, invocation) =>
        render(node.program, {
          ...frame,
          context: value,
          data: invocation?.data || frame.data,
          partials: { ...partials, '@partial-block': previous },
        });
    }
    if (!implementation && node.program) return render(node.program, frame);
    if (!implementation) throw new Error(`The partial ${name} could not be found`);
    if (typeof implementation === 'string')
      implementation = compile(implementation, options, environment);
    const result = implementation(context, {
      helpers: frame.helpers,
      partials,
      data: frame.data,
      depths:
        context === frame.context
          ? [context, ...frame.parents]
          : [context, frame.context, ...frame.parents],
    });
    if (!node.indent || options.preventIndent) return result;
    return String(result)
      .split('\n')
      .map((line, index, lines) => (index === lines.length - 1 && !line ? '' : node.indent + line))
      .join('\n');
  }
  function render(programNode, frame) {
    frame = { ...frame, partials: { ...frame.partials } };
    let result = '';
    for (const node of programNode.body) {
      if (node.type === 'ContentStatement') result += node.value;
      else if (node.type === 'CommentStatement') continue;
      else if (node.type === 'PartialStatement' || node.type === 'PartialBlockStatement')
        result += partial(node, frame);
      else if (node.type === 'DecoratorBlock' && node.path.original === 'inline') {
        const name = resolve(node.params[0], frame);
        frame.partials[name] = program(node.program, frame);
      } else if (node.type === 'MustacheStatement' || node.type === 'BlockStatement') {
        const value = expression(node, frame);
        result +=
          node.type === 'MustacheStatement' && node.escaped && !options.noEscape
            ? environment.Utils.escapeExpression(value)
            : value == null || value === false
              ? ''
              : String(value);
      } else throw new Error(`Unsupported uploaded template node: ${node.type}`);
    }
    return result;
  }
  const template = (context, invocation = {}) => {
    const data = options.data === false ? undefined : { ...invocation.data };
    if (data && !('root' in data)) data.root = context;
    return render(ast, {
      context,
      parents: invocation.depths?.slice(1) || [],
      data,
      aliases: Object.create(null),
      helpers: { ...environment.helpers, ...invocation.helpers },
      partials: { ...environment.partials, ...invocation.partials },
    });
  };
  template._setup = () => {};
  return template;
}
module.exports = { compile };
