import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadSpecs } from '../src/api-specs.js';
import { buildTools } from '../src/tools.js';
import { LOGIN, startFakeBloom, tempDir } from './fake-bloom.mjs';

const serverFile = fileURLToPath(new URL('../src/server.js', import.meta.url));
const specs = loadSpecs();

async function connect(t, { login = true, ...settings } = {}) {
  const bloom = await startFakeBloom(t);
  const client = new Client({ name: 'bgm-test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverFile],
      stderr: 'ignore',
      env: {
        ...getDefaultEnvironment(),
        BLOOM_GROWTH_BASE_URL: bloom.baseUrl,
        BLOOM_GROWTH_TOKEN_FILE: join(tempDir(t), 'token.json'),
        ...(login ? { BLOOM_GROWTH_EMAIL: LOGIN.email, BLOOM_GROWTH_PASSWORD: LOGIN.password } : {}),
        ...settings,
      },
    }),
  );
  t.after(() => client.close());
  return { client, bloom };
}

const textOf = (result) => result.content.map((part) => part.text).join('\n');

test('a client lists exactly the reading tools by default and can call one', async (t) => {
  const { client, bloom } = await connect(t);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), buildTools(specs).map((tool) => tool.name).sort());
  assert.ok(tools.every((tool) => tool.name.startsWith('get_') && tool.annotations.readOnlyHint && tool.title));
  assert.equal(tools.some((tool) => 'request' in tool || 'toolset' in tool), false);
  assert.match(client.getInstructions(), /read-only/);

  const result = await client.callTool({ name: 'get_l10_meeting_id_todos', arguments: { MEETING_ID: 42, INCLUDE_CLOSED: true } });
  const { echo } = JSON.parse(textOf(result));
  assert.equal(result.isError, undefined);
  assert.equal(echo.path, '/api/v1/l10/42/todos');
  assert.deepEqual(echo.query, { INCLUDE_CLOSED: 'true' });
  assert.equal(echo.authorization, 'Bearer token-1');
  assert.equal(bloom.apiCalls().length, 1);
});

test('a writing tool does not exist in read-only mode and sends nothing', async (t) => {
  const { client, bloom } = await connect(t);

  await assert.rejects(client.callTool({ name: 'post_todo_create', arguments: { body: { title: 'x' } } }), /Unknown tool: post_todo_create/);
  assert.equal(bloom.calls.length, 0);
});

test('with writes switched on a client can change data', async (t) => {
  const { client } = await connect(t, { BLOOM_GROWTH_WRITES: '1' });

  const { tools } = await client.listTools();
  assert.equal(tools.length, buildTools(specs, { allowWrites: true }).length);
  assert.ok(tools.some((tool) => tool.name === 'delete_rocks_rock_id' && tool.annotations.destructiveHint));

  const created = await client.callTool({ name: 'post_todo_create', arguments: { body: { title: 'Call the supplier' } } });
  assert.equal(JSON.parse(textOf(created)).echo.method, 'POST');
  assert.deepEqual(JSON.parse(textOf(created)).echo.body, { title: 'Call the supplier' });

  const completed = await client.callTool({ name: 'post_issues_issue_id_complete', arguments: { ISSUE_ID: 9 } });
  assert.equal(JSON.parse(textOf(completed)).echo.path, '/api/v1/issues/9/complete');
  assert.equal(JSON.parse(textOf(completed)).echo.body, undefined);
});

test('input that does not match the tool is refused before anything is sent', async (t) => {
  const { client, bloom } = await connect(t, { BLOOM_GROWTH_WRITES: '1' });

  for (const [name, args, message] of [
    ['get_l10_meeting_id_todos', { MEETING_ID: 42, INCLUDE_CLOSD: true }, /must NOT have additional properties \(INCLUDE_CLOSD\)/],
    ['get_l10_meeting_id_todos', {}, /must have required property 'MEETING_ID'/],
    ['get_l10_meeting_id_todos', { MEETING_ID: { id: 1 } }, /\/MEETING_ID must be integer/],
    ['get_l10_meeting_id_todos', { MEETING_ID: '..' }, /\/MEETING_ID must be integer/],
    ['post_todo_create', { body: 'a title' }, /\/body must be object/],
    ['post_todo_create', { body: {} }, /must have required property 'title'/],
    ['post_todo_create', {}, /must have required property 'body'/],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), message);
  }
  assert.equal(bloom.calls.length, 0);
});

test('toolsets narrow what a client sees', async (t) => {
  const { client } = await connect(t, { BLOOM_GROWTH_TOOLSETS: 'todos,week' });

  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name).sort(), buildTools(specs, { toolsets: ['todos', 'week'] }).map((tool) => tool.name).sort());
});

test('a long answer is cut at the limit and says so', async (t) => {
  const { client, bloom } = await connect(t, { BLOOM_GROWTH_MAX_RESPONSE_CHARS: '50' });
  bloom.state.replies.push({ payload: { text: 'x'.repeat(500) } });

  const result = await client.callTool({ name: 'get_users_mine', arguments: {} });

  assert.equal(result.content[0].text.length, 50);
  assert.match(result.content[1].text, /Cut off: the answer has \d+ characters and the limit is 50/);
});

test('an answer with no content says it is done', async (t) => {
  const { client, bloom } = await connect(t);
  bloom.state.replies.push({ status: 204, raw: '' });

  const result = await client.callTool({ name: 'get_users_mine', arguments: {} });

  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /^Done\./);
});

test('without a login the tool answers with what to set', async (t) => {
  const { client, bloom } = await connect(t, { login: false });

  const result = await client.callTool({ name: 'get_users_mine', arguments: {} });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /Set BLOOM_GROWTH_EMAIL and BLOOM_GROWTH_PASSWORD/);
  assert.equal(bloom.calls.length, 0);
});

test('a setting it cannot use stops the server at startup with the reason', () => {
  for (const [settings, message] of [
    [{ BLOOM_GROWTH_TOOLSETS: 'todos,nope' }, /Unknown toolset: nope/],
    [{ BLOOM_GROWTH_WRITES: 'maybe' }, /BLOOM_GROWTH_WRITES must be 1 or 0/],
    [{ BLOOM_GROWTH_BASE_URL: 'http://example.com' }, /must use https/],
  ]) {
    const run = spawnSync(process.execPath, [serverFile], { env: { ...getDefaultEnvironment(), ...settings }, input: '', encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, message);
    assert.equal(run.stdout, '');
  }
});
