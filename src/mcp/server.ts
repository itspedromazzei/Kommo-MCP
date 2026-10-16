import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import axios from 'axios';
import { z } from 'zod';
import { KommoAPI } from '../kommo-api.js';
import { MCP_TOOLS } from './tool-definitions.js';
import { executeTool } from './tool-handlers.js';
import { MCP_RESOURCES, readResource } from './resources.js';
import { MCP_PROMPTS, getPromptMessages } from './prompts.js';

const WRITE_TOOLS = new Set([
  'create_lead',
  'update_lead',
  'move_lead',
  'create_task',
  'add_note',
  'pin_note',
  'unpin_note',
  'run_salesbot',
  'stop_salesbot',
]);

const MAX_DETAIL_LENGTH = 200;
const MAX_VALIDATION_ERRORS = 10;

// Só aceita texto, tira caracteres de controle, mascara sequências com cara de token e corta.
function sanitizeDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/Bearer\s+\S+/gi, 'Bearer [removido]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[removido]')
    .replace(/[A-Za-z0-9_\-=+/]{40,}/g, '[removido]')
    .trim();
  if (!clean) return undefined;
  return clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH)}…` : clean;
}

// Resume o corpo de um 400 do Kommo (detail + validation-errors) sem ecoar o payload enviado.
export function describeKommoBadRequest(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const body = data as Record<string, unknown>;
  const parts: string[] = [];
  const detail = sanitizeDetail(body.detail) ?? sanitizeDetail(body.title);
  if (detail) parts.push(detail);
  const groups = Array.isArray(body['validation-errors']) ? body['validation-errors'] : [];
  const fieldErrors = groups.flatMap((group: unknown) => {
    const errors = (group as { errors?: unknown } | null)?.errors;
    return Array.isArray(errors) ? errors : [];
  });
  for (const fieldError of fieldErrors.slice(0, MAX_VALIDATION_ERRORS)) {
    const item = (fieldError ?? {}) as Record<string, unknown>;
    const path = sanitizeDetail(item.path);
    const description = [sanitizeDetail(item.code), sanitizeDetail(item.detail)]
      .filter(Boolean)
      .join(': ');
    if (path || description) parts.push(path ? `${path} → ${description}` : description);
  }
  if (fieldErrors.length > MAX_VALIDATION_ERRORS) {
    parts.push(`(+${fieldErrors.length - MAX_VALIDATION_ERRORS} erros)`);
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

export function safeToolError(error: unknown) {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 400) {
      const detail = describeKommoBadRequest(error.response?.data);
      return {
        content: [
          {
            type: 'text' as const,
            text: detail
              ? `O Kommo recusou a requisição (400): ${detail}`
              : 'O Kommo recusou a requisição (400).',
          },
        ],
        isError: true,
      };
    }
    const message =
      status === 401
        ? 'A autenticação com o Kommo falhou.'
        : status === 403
          ? 'A credencial não possui permissão para esta operação.'
          : status === 404
            ? 'O recurso solicitado não foi encontrado no Kommo.'
            : status === 429
              ? 'O limite de requisições do Kommo foi atingido. Tente novamente mais tarde.'
              : error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
                ? 'A requisição ao Kommo excedeu o tempo limite.'
                : 'A API do Kommo não conseguiu concluir a operação.';
    return { content: [{ type: 'text' as const, text: message }], isError: true };
  }
  return {
    content: [{ type: 'text' as const, text: 'Erro interno ao executar a tool.' }],
    isError: true,
  };
}

export function createKommoMcpServer(kommoAPI: KommoAPI): McpServer {
  const server = new McpServer({
    name: 'kommo-mcp-server',
    version: '3.0.0',
    description: 'MCP Server for Kommo CRM integration',
  });

  for (const tool of MCP_TOOLS) {
    const isWrite = WRITE_TOOLS.has(tool.name);
    const schema = isWrite
      ? {
          ...tool.inputSchema,
          properties: {
            ...((tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {}),
            confirm: {
              type: 'boolean',
              description: 'Confirma explicitamente a operação de escrita quando exigido.',
            },
          },
        }
      : tool.inputSchema;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(schema),
        annotations: {
          readOnlyHint: !isWrite,
          destructiveHint: isWrite,
          idempotentHint: !isWrite || tool.name === 'pin_note' || tool.name === 'unpin_note',
          openWorldHint: true,
        },
      },
      async (args) => {
        if (isWrite && process.env.MCP_CONFIRM_WRITES === 'true' && args.confirm !== true) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Esta operação exige confirm=true porque MCP_CONFIRM_WRITES está ativo.',
              },
            ],
            isError: true,
          };
        }
        const toolArgs = { ...args };
        delete toolArgs.confirm;
        try {
          return await executeTool(kommoAPI, tool.name, toolArgs);
        } catch (error) {
          return safeToolError(error);
        }
      },
    );
  }

  for (const resource of MCP_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      },
      async (uri) => ({
        contents: await (async () => {
          try {
            return [
              {
                uri: uri.href,
                mimeType: resource.mimeType,
                text: await readResource(kommoAPI, uri.href),
              },
            ];
          } catch {
            throw new Error('Não foi possível carregar este resource do Kommo.');
          }
        })(),
      }),
    );
  }

  for (const prompt of MCP_PROMPTS) {
    const shape = Object.fromEntries(
      prompt.arguments.map((argument) => [
        argument.name,
        argument.required ? z.string() : z.string().optional(),
      ]),
    );
    server.registerPrompt(
      prompt.name,
      {
        description: prompt.description,
        argsSchema: z.object(shape),
      },
      async () => ({ messages: getPromptMessages(prompt.name) }),
    );
  }

  return server;
}
