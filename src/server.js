#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { loadSpecs } from './api-specs.js';
import { createBloomClient, toRequest } from './bloom-client.js';
import { readConfig } from './config.js';
import { buildInstructions, buildTools } from './tools.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

let config;
let tools;
const specs = loadSpecs();
try {
  config = readConfig();
  tools = buildTools(specs, config);
} catch (error) {
  process.stderr.write(`bloom-growth-mcp: ${error.message}\n`);
  process.exit(1);
}

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const toolsByName = new Map(tools.map((tool) => [tool.name, { ...tool, validate: ajv.compile(tool.inputSchema) }]));
const client = createBloomClient(config);

const server = new Server(
  { name: 'bloom-growth', version },
  { capabilities: { tools: {} }, instructions: buildInstructions(specs, config) },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ request, toolset, ...tool }) => tool),
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const tool = toolsByName.get(params.name);
  if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
  const args = params.arguments ?? {};
  try {
    if (!tool.validate(args)) throw new Error(`Invalid input: ${describe(tool.validate.errors)}`);
    return toResult(await client.request(toRequest(tool.request, args)));
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});

function describe(errors) {
  return errors
    .map((error) => {
      const where = error.instancePath || 'input';
      const extra = error.params?.additionalProperty ? ` (${error.params.additionalProperty})` : '';
      return `${where} ${error.message}${extra}`;
    })
    .join('; ');
}

function toResult(payload) {
  if (payload === null) return { content: [{ type: 'text', text: 'Done. Bloom Growth sent no content.' }] };
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (text.length <= config.maxResponseChars) return { content: [{ type: 'text', text }] };
  return {
    content: [
      { type: 'text', text: text.slice(0, config.maxResponseChars) },
      {
        type: 'text',
        text: `Cut off: the answer has ${text.length} characters and the limit is ${config.maxResponseChars}. Call a narrower tool, or raise BLOOM_GROWTH_MAX_RESPONSE_CHARS.`,
      },
    ],
  };
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
