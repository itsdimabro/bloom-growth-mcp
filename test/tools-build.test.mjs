import assert from 'node:assert/strict';
import { test } from 'node:test';
import Ajv from 'ajv';
import { loadSpecs } from '../src/api-specs.js';
import { buildInstructions, buildTools, listToolsets, toolName } from '../src/tools.js';

const specs = loadSpecs();
const allTools = buildTools(specs, { allowWrites: true });
const readTools = buildTools(specs);
const byName = Object.fromEntries(allTools.map((tool) => [tool.name, tool]));

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const rawOperations = specs.flatMap((spec) =>
  Object.entries(spec.paths)
    .filter(([path]) => path !== '/token')
    .flatMap(([path, item]) => Object.keys(item).filter((key) => HTTP_METHODS.has(key)).map((method) => `${method.toUpperCase()} ${path}`)),
);

test('every operation in the saved API description becomes exactly one tool', () => {
  assert.ok(rawOperations.length > 100);
  assert.deepEqual(allTools.map((tool) => `${tool.request.method} ${tool.request.path}`).sort(), [...rawOperations].sort());
  assert.equal(new Set(allTools.map((tool) => tool.name)).size, allTools.length);
});

test('the sign-in endpoint is never a tool', () => {
  assert.equal(allTools.some((tool) => tool.request.path === '/token'), false);
});

test('read-only mode lists the GET operations and nothing that changes data', () => {
  assert.deepEqual(readTools.map((tool) => tool.name).sort(), allTools.filter((tool) => tool.name.startsWith('get_')).map((tool) => tool.name).sort());
  assert.ok(readTools.every((tool) => tool.request.method === 'GET'));
  for (const name of ['post_todo_create', 'delete_rocks_rock_id', 'put_scores_score_id', 'patch_role_role_id_restore']) {
    assert.ok(byName[name], name);
    assert.equal(readTools.some((tool) => tool.name === name), false, name);
  }
});

test('tool names fit what MCP clients accept', () => {
  for (const tool of allTools) assert.match(tool.name, /^[a-z0-9_]{1,64}$/);
});

test('names follow the method and path', () => {
  assert.equal(toolName('get', '/api/v1/rocks/user/mine'), 'get_rocks_user_mine');
  assert.equal(toolName('get', '/api/v1/L10/{MEETING_ID}/rocks'), 'get_l10_meeting_id_rocks');
  assert.equal(toolName('get', '/api/v2/users/{userId}/scorecard'), 'get_v2_users_user_id_scorecard');
});

test('every input schema is one a validator accepts, with no OpenAPI-only words', () => {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  for (const tool of allTools) assert.doesNotThrow(() => ajv.compile(tool.inputSchema), tool.name);

  const text = JSON.stringify(allTools.map((tool) => tool.inputSchema));
  assert.equal(text.includes('"$ref"'), false);
  assert.equal(text.includes('"nullable"'), false);
  assert.equal(text.includes('"readOnly":true'), false);
});

test('every path placeholder is a required input, and required names only real inputs', () => {
  for (const tool of allTools) {
    const required = tool.inputSchema.required ?? [];
    for (const [, name] of tool.request.path.matchAll(/\{([^}]+)\}/g)) assert.ok(required.includes(name), `${tool.name}: ${name}`);
    for (const name of required) assert.ok(name in tool.inputSchema.properties, `${tool.name}: ${name}`);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
});

test('a body is required only when the operation cannot work without one', () => {
  assert.deepEqual(byName.post_todo_create.inputSchema.required, ['body']);
  assert.deepEqual(byName.post_todo_create.inputSchema.properties.body.required, ['title']);
  assert.equal(byName.post_todo_create.request.bodyRequired, true);

  const optional = allTools.filter((tool) => tool.request.hasBody && !tool.request.bodyRequired);
  assert.ok(optional.length > 0);
  for (const tool of optional) {
    assert.equal(tool.inputSchema.required?.includes('body') ?? false, false, tool.name);
    assert.equal(tool.inputSchema.properties.body.required?.length ?? 0, 0, tool.name);
  }
});

test('annotations tell a client which tools read, change and delete', () => {
  assert.deepEqual(
    { ...byName.get_rocks_rock_id.annotations, title: undefined },
    { title: undefined, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  );
  assert.equal(byName.delete_rocks_rock_id.annotations.destructiveHint, true);
  assert.equal(byName.delete_rocks_rock_id.annotations.readOnlyHint, false);
  assert.equal(byName.put_rocks_rock_id.annotations.idempotentHint, true);
  assert.equal(byName.post_todo_create.annotations.idempotentHint, false);
  assert.equal(byName.post_todo_create.annotations.destructiveHint, false);
  for (const tool of allTools) assert.ok(tool.title.length > 0 && tool.title === tool.annotations.title, tool.name);
});

test('toolsets come from the API description and narrow the list', () => {
  const toolsets = listToolsets(specs);
  for (const name of ['todos', 'rocks', 'issues', 'l10', 'scorecard', 'users']) assert.ok(toolsets.includes(name), name);

  const picked = buildTools(specs, { toolsets: ['todos', 'week'] });
  assert.deepEqual([...new Set(picked.map((tool) => tool.toolset))].sort(), ['todos', 'week']);
  assert.ok(picked.some((tool) => tool.name === 'get_todo_users_mine'));
  assert.ok(picked.some((tool) => tool.name === 'get_weeks_current'));
  assert.equal(picked.some((tool) => tool.name === 'get_rocks_user_mine'), false);

  const total = toolsets.reduce((sum, name) => sum + buildTools(specs, { toolsets: [name], allowWrites: true }).length, 0);
  assert.equal(total, allTools.length);
});

test('an unknown toolset stops the build and lists the real ones', () => {
  assert.throws(() => buildTools(specs, { toolsets: ['todos', 'nope'] }), /Unknown toolset: nope\. Choose from: .*todos/);
});

test('an operation-level parameter replaces a path-level one of the same name', () => {
  const spec = {
    paths: {
      '/api/v1/things/{ID}': {
        parameters: [{ name: 'ID', in: 'path', required: true, schema: { type: 'string' }, description: 'path level' }],
        get: { parameters: [{ name: 'ID', in: 'path', required: true, schema: { type: 'integer' }, description: 'operation level' }] },
      },
    },
  };

  const [tool] = buildTools([spec]);

  assert.deepEqual(tool.inputSchema.properties.ID, { type: 'integer', description: 'operation level' });
  assert.equal(tool.title, 'get_things_id');
});

test('two operations that would share a name stop the build', () => {
  const spec = { paths: { '/api/v1/A': { get: {} }, '/api/v1/a': { get: {} } } };

  assert.throws(() => buildTools([spec]), /share the tool name get_a/);
});

test('instructions say the mode and carry the name table', () => {
  assert.match(buildInstructions(specs), /read-only/);
  assert.match(buildInstructions(specs, { allowWrites: true }), /Changes are real/);
  assert.match(buildInstructions(specs), /Quarterly Priorities \| rocks/);
});
