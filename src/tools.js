const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const TOKEN_PATH = '/token';
const BODY_KEY = 'body';
const UNTAGGED_TOOLSET = 'other';
const INSTRUCTION_SECTIONS = ['Who the API acts as', 'Bloom Growth names in the API', 'Weekly KPI scores'];

/** Lists every operation of the given OpenAPI specs once, as { method, path, operation, pathParameters, spec }. */
export function listOperations(specs) {
  const seen = new Set();
  const operations = [];
  for (const spec of specs) {
    for (const [path, item] of Object.entries(spec.paths)) {
      if (path === TOKEN_PATH) continue;
      for (const method of METHODS) {
        const key = `${method} ${path}`;
        if (!item[method] || seen.has(key)) continue;
        seen.add(key);
        operations.push({ method, path, operation: item[method], pathParameters: item.parameters ?? [], spec });
      }
    }
  }
  return operations;
}

export function toolName(method, path) {
  const segments = path
    .split('/')
    .filter((segment) => segment && segment !== 'api' && segment !== 'v1')
    .map((segment) => segment.replace(/[{}]/g, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
  return [method, ...segments].join('_');
}

/** The toolset an operation belongs to: its first tag in the API description, in lower case. */
export function toolsetOf(operation) {
  const tag = operation.tags?.[0];
  return tag ? tag.toLowerCase().replace(/[^a-z0-9]+/g, '') : UNTAGGED_TOOLSET;
}

export function listToolsets(specs) {
  return [...new Set(listOperations(specs).map(({ operation }) => toolsetOf(operation)))].sort();
}

/**
 * Turns the specs into MCP tools. Each tool keeps the request shape the client needs to send
 * it. Without allowWrites only GET operations become tools. toolsets, when given, keeps only
 * the operations of those toolsets and throws on a name the specs do not have.
 */
export function buildTools(specs, { allowWrites = false, toolsets = null } = {}) {
  if (toolsets) {
    const known = listToolsets(specs);
    const unknown = toolsets.filter((name) => !known.includes(name));
    if (unknown.length) throw new Error(`Unknown toolset: ${unknown.join(', ')}. Choose from: ${known.join(', ')}`);
  }

  const tools = [];
  const names = new Set();
  for (const { method, path, operation, pathParameters, spec } of listOperations(specs)) {
    if (method !== 'get' && !allowWrites) continue;
    const toolset = toolsetOf(operation);
    if (toolsets && !toolsets.includes(toolset)) continue;
    const name = toolName(method, path);
    if (names.has(name)) throw new Error(`Two operations share the tool name ${name}`);
    names.add(name);

    const parameters = mergeParameters(pathParameters, operation.parameters ?? []);
    const properties = {};
    const required = [];
    for (const parameter of parameters) {
      if (parameter.name === BODY_KEY || properties[parameter.name]) {
        throw new Error(`${name}: parameter ${parameter.name} clashes with another input`);
      }
      properties[parameter.name] = {
        ...toJsonSchema(parameter.schema ?? {}, spec),
        ...(parameter.description ? { description: parameter.description } : {}),
      };
      if (parameter.required || parameter.in === 'path') required.push(parameter.name);
    }

    const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
    let bodyRequired = false;
    if (bodySchema) {
      const body = toJsonSchema(bodySchema, spec);
      bodyRequired = operation.requestBody.required === true || Boolean(body.required?.length);
      properties[BODY_KEY] = {
        ...body,
        ...(operation.requestBody.description ? { description: operation.requestBody.description } : {}),
      };
      if (bodyRequired) required.push(BODY_KEY);
    }

    const summary = clean(operation.summary);
    const title = summary.split('\n')[0] || name;
    tools.push({
      name,
      title,
      description: [summary, clean(operation.description), `${method.toUpperCase()} ${path}`].filter(Boolean).join('\n\n'),
      inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
      annotations: {
        title,
        readOnlyHint: method === 'get',
        destructiveHint: method === 'delete',
        idempotentHint: method !== 'post' && method !== 'patch',
        openWorldHint: true,
      },
      toolset,
      request: {
        method: method.toUpperCase(),
        path,
        queryParams: parameters.filter((p) => p.in === 'query').map((p) => p.name),
        hasBody: Boolean(bodySchema),
        bodyRequired,
      },
    });
  }
  return tools;
}

/** The parts of Bloom's own API guide an agent needs before it calls a tool. */
export function buildInstructions(specs, { allowWrites = false } = {}) {
  const guide = clean(specs[0]?.info?.description);
  const sections = guide
    .split(/\n(?=### )/)
    .filter((section) => INSTRUCTION_SECTIONS.some((heading) => section.startsWith(`### ${heading}`)))
    .map((section) => section.trim());
  const mode = allowWrites
    ? 'This server can read and change Bloom Growth data. Changes are real and act as the signed-in user.'
    : 'This server is read-only: it lists only the GET operations of the Bloom Growth API.';
  return [mode, ...sections].join('\n\n');
}

function mergeParameters(pathLevel, operationLevel) {
  const merged = new Map();
  for (const parameter of [...pathLevel, ...operationLevel]) merged.set(`${parameter.in}:${parameter.name}`, parameter);
  return [...merged.values()];
}

function clean(text) {
  return (text ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function toJsonSchema(schema, spec, trail = []) {
  if (schema.$ref) {
    if (trail.includes(schema.$ref)) return {};
    const target = spec.components?.schemas?.[schema.$ref.split('/').pop()];
    if (!target) throw new Error(`The API description points at a schema it does not have: ${schema.$ref}`);
    return toJsonSchema(target, spec, [...trail, schema.$ref]);
  }

  const { nullable, readOnly, xml, example, ...rest } = schema;
  const out = { ...rest };

  if (out.enum && out.type === 'integer' && out.enum.every((value) => typeof value === 'string')) {
    const names = out.enum.join(', ');
    delete out.enum;
    delete out.format;
    out.type = ['integer', 'string'];
    out.description = [out.description, `Bloom lists these values: ${names}. Its API description types the field as a number.`]
      .filter(Boolean)
      .join(' ');
  }

  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties)
        .filter(([, property]) => !property.readOnly)
        .map(([key, property]) => [key, toJsonSchema(property, spec, trail)]),
    );
    if (out.required) out.required = out.required.filter((key) => key in out.properties);
  }
  if (out.items) out.items = toJsonSchema(out.items, spec, trail);
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (out[key]) out[key] = out[key].map((part) => toJsonSchema(part, spec, trail));
  }
  if (out.additionalProperties && typeof out.additionalProperties === 'object') {
    out.additionalProperties = toJsonSchema(out.additionalProperties, spec, trail);
  }

  if (nullable && out.type) {
    out.type = [...new Set([...[out.type].flat(), 'null'])];
    if (out.enum && !out.enum.includes(null)) out.enum = [...out.enum, null];
  }
  return out;
}
