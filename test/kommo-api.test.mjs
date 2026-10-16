import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { KommoAPI, parseRetryAfter } from '../dist/kommo-api.js';
import { safeToolError } from '../dist/mcp/server.js';

test('rejects unsafe retry and timeout configuration', () => {
  const baseConfig = { baseUrl: 'https://example.kommo.com', accessToken: 'token' };
  assert.throws(() => new KommoAPI({ ...baseConfig, timeoutMs: 0 }), /positive integer/);
  assert.throws(() => new KommoAPI({ ...baseConfig, maxRetries: -1 }), /between 0 and 10/);
  assert.doesNotThrow(() => new KommoAPI({ ...baseConfig, maxRetries: 0 }));
});

async function withServer(context, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('Salesbot requests follow the documented v4 payloads', async (context) => {
  const calls = [];
  const baseUrl = await withServer(context, async (request, response) => {
    calls.push({ method: request.method, url: request.url, body: await requestBody(request) });
    response.writeHead(202).end();
  });
  const api = new KommoAPI({ baseUrl, accessToken: 'test', maxRetries: 0 });

  assert.deepEqual(await api.runSalesbot(7, 42, 'leads'), { accepted: true });
  assert.deepEqual(await api.stopSalesbot(7, 42, 'leads'), { accepted: true });
  assert.deepEqual(calls, [
    {
      method: 'POST',
      url: '/api/v4/bots/run',
      body: [{ bot_id: 7, entity_id: 42, entity_type: 'leads' }],
    },
    {
      method: 'POST',
      url: '/api/v4/bots/7/stop',
      body: { entity_id: 42, entity_type: 'leads' },
    },
  ]);
});

test('GET requests retry a 429 and honor Retry-After', async (context) => {
  let attempts = 0;
  const baseUrl = await withServer(context, (_request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(429, { 'Retry-After': '0' }).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":1,"name":"Conta"}');
  });
  const api = new KommoAPI({ baseUrl, accessToken: 'test', maxRetries: 1 });

  assert.equal((await api.getAccount()).id, 1);
  assert.equal(attempts, 2);
  assert.equal(parseRetryAfter('2'), 2000);
});

test('coordinates concurrent requests below the configured process rate', async (context) => {
  const receivedAt = [];
  const baseUrl = await withServer(context, (_request, response) => {
    receivedAt.push(Date.now());
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":1,"name":"Conta"}');
  });
  const firstApi = new KommoAPI({
    baseUrl,
    accessToken: 'test',
    maxRetries: 0,
    requestsPerSecond: 5,
  });
  const secondApi = new KommoAPI({
    baseUrl,
    accessToken: 'test',
    maxRetries: 0,
    requestsPerSecond: 5,
  });

  await Promise.all([firstApi.getAccount(), secondApi.getAccount()]);

  assert.equal(receivedAt.length, 2);
  assert.ok(receivedAt[1] - receivedAt[0] >= 180);
});

test('pagination failures are propagated instead of returning partial totals', async (context) => {
  const baseUrl = await withServer(context, (request, response) => {
    const page = new URL(request.url, baseUrl).searchParams.get('page');
    if (page === '1') {
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end('{"_embedded":{"leads":[{"id":1}]},"_links":{"next":{"href":"next"}}}');
      return;
    }
    response.writeHead(503).end();
  });
  const api = new KommoAPI({ baseUrl, accessToken: 'test', maxRetries: 0 });

  await assert.rejects(
    () => api.getAllLeads(),
    (error) => error.response?.status === 503,
  );
});

test('sales reports are calculated from documented leads, pipelines and users endpoints', async (context) => {
  const paths = [];
  const baseUrl = await withServer(context, (request, response) => {
    const url = new URL(request.url, baseUrl);
    paths.push(url.pathname);
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v4/account') {
      response.end(JSON.stringify({ id: 1, name: 'Conta', timezone: 'UTC' }));
      return;
    }
    if (url.pathname === '/api/v4/leads') {
      response.end(
        JSON.stringify({
          _embedded: {
            leads: [
              {
                id: 1,
                name: 'Ganho',
                price: 100,
                status_id: 142,
                pipeline_id: 3,
                responsible_user_id: 5,
                created_at: 1767225600,
                updated_at: 1767225600,
                created_by: 5,
                closed_at: 1767225600,
              },
              {
                id: 2,
                name: 'Perdido',
                price: 50,
                status_id: 143,
                pipeline_id: 3,
                responsible_user_id: 5,
                created_at: 1767225600,
                updated_at: 1767225600,
                created_by: 5,
                closed_at: 1767225600,
              },
            ],
          },
        }),
      );
      return;
    }
    if (url.pathname === '/api/v4/leads/pipelines') {
      response.end(JSON.stringify({ _embedded: { pipelines: [{ id: 3, name: 'Vendas' }] } }));
      return;
    }
    if (url.pathname === '/api/v4/users') {
      response.end(JSON.stringify({ _embedded: { users: [{ id: 5, name: 'Ana' }] } }));
      return;
    }
    response.writeHead(404).end();
  });
  const api = new KommoAPI({ baseUrl, accessToken: 'test', maxRetries: 0 });

  const report = await api.getSalesReport('2026-01-01', '2026-01-31');
  assert.equal(report.leads.won, 1);
  assert.equal(report.leads.lost, 1);
  assert.equal(report.revenue.total, 100);
  assert.equal(report.revenue.conversion_rate, 50);
  assert.ok(paths.every((path) => !path.includes('reports') && !path.includes('dashboard')));
});

test('sales reports use account timezone boundaries and reject impossible dates', async (context) => {
  const baseUrl = await withServer(context, (request, response) => {
    const url = new URL(request.url, baseUrl);
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v4/account') {
      response.end(JSON.stringify({ id: 1, name: 'Conta', timezone: 'America/Sao_Paulo' }));
      return;
    }
    if (url.pathname === '/api/v4/leads') {
      const lead = (id, createdAt) => ({
        id,
        name: `Lead ${id}`,
        price: 100,
        status_id: 142,
        pipeline_id: 3,
        responsible_user_id: 5,
        created_at: createdAt,
        updated_at: createdAt,
        created_by: 5,
        closed_at: createdAt,
      });
      response.end(
        JSON.stringify({
          _embedded: {
            leads: [
              lead(1, Date.parse('2026-01-01T02:59:59Z') / 1000),
              lead(2, Date.parse('2026-01-01T03:00:00Z') / 1000),
            ],
          },
        }),
      );
      return;
    }
    if (url.pathname === '/api/v4/leads/pipelines') {
      response.end(JSON.stringify({ _embedded: { pipelines: [{ id: 3, name: 'Vendas' }] } }));
      return;
    }
    if (url.pathname === '/api/v4/users') {
      response.end(JSON.stringify({ _embedded: { users: [{ id: 5, name: 'Ana' }] } }));
      return;
    }
    response.writeHead(404).end();
  });
  const api = new KommoAPI({ baseUrl, accessToken: 'test', maxRetries: 0 });

  const report = await api.getSalesReport('2026-01-01', '2026-01-01');
  assert.equal(report.leads.total, 1);
  assert.equal(report.leads.won, 1);
  await assert.rejects(
    () => api.getSalesReport('2026-02-31', '2026-03-01'),
    /datas reais no formato YYYY-MM-DD/,
  );
});

test('listLeads orders by newest first and applies documented filters', async (context) => {
  const urls = [];
  const baseUrl = await withServer(context, (request, response) => {
    urls.push(request.url);
    if (request.url.startsWith('/api/v4/account')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 1, name: 'x', subdomain: 'x', timezone: 'UTC' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ _embedded: { leads: [] } }));
  });
  const api = new KommoAPI({ baseUrl, accessToken: 'test', maxRetries: 0 });

  await api.listLeads({ limit: 5 });
  const defaultQuery = decodeURIComponent(urls.at(-1));
  assert.match(defaultQuery, /order\[created_at\]=desc/);
  assert.match(defaultQuery, /limit=5/);

  await api.listLeads({ orderBy: 'updated_at', orderDirection: 'asc' });
  assert.match(decodeURIComponent(urls.at(-1)), /order\[updated_at\]=asc/);

  await api.listLeads({ createdFrom: '2026-09-01', createdTo: '2026-09-01' });
  const dateQuery = decodeURIComponent(urls.at(-1));
  const from = Date.UTC(2026, 8, 1) / 1000;
  assert.match(dateQuery, new RegExp(`filter\\[created_at\\]\\[from\\]=${from}`));
  // O "to" cobre o dia inteiro: ultimo segundo antes da meia-noite seguinte.
  assert.match(dateQuery, new RegExp(`filter\\[created_at\\]\\[to\\]=${from + 86399}`));

  await api.listLeads({ pipelineId: 10, statusId: 20 });
  const statusQuery = decodeURIComponent(urls.at(-1));
  assert.match(statusQuery, /filter\[statuses\]\[0\]\[pipeline_id\]=10/);
  assert.match(statusQuery, /filter\[statuses\]\[0\]\[status_id\]=20/);

  await assert.rejects(() => api.listLeads({ statusId: 20 }), /exige pipeline_id/);
});

test('listLeads returns an empty list when Kommo answers 204', async (context) => {
  const baseUrl = await withServer(context, (_request, response) => {
    response.writeHead(204).end();
  });
  const api = new KommoAPI({ baseUrl, accessToken: 'test', maxRetries: 0 });
  assert.deepEqual(await api.listLeads({ query: 'inexistente' }), { _embedded: { leads: [] } });
});

function sendJson(response, body) {
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

test('custom fields walk every page of the documented entity endpoint', async (context) => {
  const urls = [];
  const baseUrl = await withServer(context, (request, response) => {
    urls.push(request.url);
    const url = new URL(request.url, baseUrl);
    const page = url.searchParams.get('page');
    if (url.pathname === '/api/v4/contacts/custom_fields') {
      response.writeHead(204).end();
      return;
    }
    sendJson(response, {
      _embedded: {
        custom_fields: [{ id: Number(page), name: `Campo ${page}`, type: 'select', enums: [] }],
      },
      _links: page === '1' ? { next: { href: 'next' } } : {},
    });
  });
  const api = new KommoAPI({ baseUrl, accessToken: 'test', maxRetries: 0 });

  const leadFields = await api.getCustomFields('leads');
  assert.deepEqual(
    leadFields.map((field) => field.id),
    [1, 2],
  );
  assert.deepEqual(await api.getCustomFields('contacts'), []);
  assert.deepEqual(urls, [
    '/api/v4/leads/custom_fields?limit=50&page=1',
    '/api/v4/leads/custom_fields?limit=50&page=2',
    '/api/v4/contacts/custom_fields?limit=50&page=1',
  ]);
});

test('sources come from /api/v4/sources and 204 means no sources', async (context) => {
  let empty = false;
  const urls = [];
  const baseUrl = await withServer(context, (request, response) => {
    urls.push(request.url);
    if (empty) {
      response.writeHead(204).end();
      return;
    }
    sendJson(response, {
      _embedded: { sources: [{ id: 3, name: 'WhatsApp', pipeline_id: 9, external_id: 'wa' }] },
    });
  });
  const api = new KommoAPI({ baseUrl, accessToken: 'test', maxRetries: 0 });

  assert.deepEqual(await api.getSources(), [
    { id: 3, name: 'WhatsApp', pipeline_id: 9, external_id: 'wa' },
  ]);
  empty = true;
  assert.deepEqual(await api.getSources(), []);
  assert.deepEqual(urls, ['/api/v4/sources', '/api/v4/sources']);
});

test('salesbots page through /api/v4/bots using _page_count and the type filter', async (context) => {
  const urls = [];
  const baseUrl = await withServer(context, (request, response) => {
    urls.push(decodeURIComponent(request.url));
    const page = Number(new URL(request.url, baseUrl).searchParams.get('page'));
    sendJson(response, {
      _total_items: 2,
      _page: page,
      _page_count: 2,
      _links: { self: { href: 'self' } },
      _embedded: { items: [{ id: page, name: `Bot ${page}`, type_functionality: 'regular' }] },
    });
  });
  const api = new KommoAPI({ baseUrl, accessToken: 'test', maxRetries: 0 });

  const bots = await api.getSalesbots('regular');
  assert.deepEqual(
    bots.map((bot) => bot.id),
    [1, 2],
  );
  assert.deepEqual(urls, [
    '/api/v4/bots?filter[type_functionality][]=regular&limit=250&page=1',
    '/api/v4/bots?filter[type_functionality][]=regular&limit=250&page=2',
  ]);
});

test('chat templates request review status and tolerate an empty account', async (context) => {
  let empty = false;
  const urls = [];
  const baseUrl = await withServer(context, (request, response) => {
    urls.push(request.url);
    if (empty) {
      response.writeHead(204).end();
      return;
    }
    sendJson(response, {
      _page: 1,
      _links: { self: { href: 'self' } },
      _embedded: {
        chat_templates: [{ id: 11, name: 'Boas-vindas', type: 'waba', review_status: 'approved' }],
      },
    });
  });
  const api = new KommoAPI({ baseUrl, accessToken: 'test', maxRetries: 0 });

  assert.deepEqual(await api.getChatTemplates(), [
    { id: 11, name: 'Boas-vindas', type: 'waba', review_status: 'approved' },
  ]);
  empty = true;
  assert.deepEqual(await api.getChatTemplates(), []);
  assert.deepEqual(urls, [
    '/api/v4/chats/templates?with=reviews&limit=50&page=1',
    '/api/v4/chats/templates?with=reviews&limit=50&page=1',
  ]);
});

test('400 errors expose the sanitized Kommo detail to the MCP client', async (context) => {
  const token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNlY3JldA';
  const baseUrl = await withServer(context, (_request, response) => {
    response.writeHead(400, { 'Content-Type': 'application/problem+json' }).end(
      JSON.stringify({
        title: 'Bad Request',
        type: 'https://httpstatus.es/400',
        status: 400,
        detail: `Request validation failed\nBearer ${token}`,
        'validation-errors': [
          {
            request_id: '0',
            errors: [
              {
                code: 'NotSupportedChoice',
                path: 'custom_fields_values.0.values.0.enum_id',
                detail: 'The value you selected is not a valid choice.',
              },
            ],
          },
        ],
      }),
    );
  });
  const api = new KommoAPI({ baseUrl, accessToken: 'test', maxRetries: 0 });

  const error = await api.createLead({ name: 'Teste' }).catch((caught) => caught);
  const result = safeToolError(error);

  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    'O Kommo recusou a requisição (400): Request validation failed Bearer [removido]; ' +
      'custom_fields_values.0.values.0.enum_id → NotSupportedChoice: The value you selected is not a valid choice.',
  );
  assert.doesNotMatch(result.content[0].text, /eyJ/);
});

test('400 errors without a readable body keep a generic message', async (context) => {
  const baseUrl = await withServer(context, (_request, response) => {
    response.writeHead(400).end('<html>bad</html>');
  });
  const api = new KommoAPI({ baseUrl, accessToken: 'test', maxRetries: 0 });

  const error = await api.createLead({ name: 'Teste' }).catch((caught) => caught);

  assert.equal(safeToolError(error).content[0].text, 'O Kommo recusou a requisição (400).');
});
