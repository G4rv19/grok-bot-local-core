'use strict';
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const server = new McpServer({ name: 'local-test-connector', version: '1.0' });
server.registerTool('echo', { description: 'Return the supplied test text', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: 'MCP_FIXTURE:' + text }] }));
server.connect(new StdioServerTransport());
