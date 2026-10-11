// Fake-Upstream fuer die Integrationstests: ein node:http-Server, der aufgezeichnete
// SSE-Antworten liefert (auf Wunsch gzip-komprimiert), Fehler simuliert und Kopfzeilen
// sowie Body zurueckspiegelt. Szenario ueber den Query-Parameter "szenario".
import http from 'node:http';

export const SSE_TEXT = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":12,"cache_creation_input_tokens":1100,"cache_read_input_tokens":3000,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":1100},"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: ping',
  'data: {"type": "ping"}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hallo – äöü"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":42}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

export const JSON_ANTWORT = {
  id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: 'max_tokens',
  usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 0 },
};

function fehlerJson(typ, nachricht) {
  return JSON.stringify({ type: 'error', error: { type: typ, message: nachricht } });
}

// Zerlegt den Text absichtlich mitten in Zeilen und mitten in Mehrbyte-Zeichen.
function zerlege(puffer) {
  const teile = [];
  const groessen = [7, 50, 3, 120, 1, 64];
  let pos = 0;
  let i = 0;
  while (pos < puffer.length) {
    const g = groessen[i % groessen.length];
    teile.push(puffer.subarray(pos, pos + g));
    pos += g;
    i += 1;
  }
  return teile;
}

async function gzip(puffer) {
  const strom = new Blob([puffer]).stream().pipeThrough(new CompressionStream('gzip'));
  return Buffer.from(await new Response(strom).arrayBuffer());
}

async function schreibeTeile(res, teile) {
  for (const teil of teile) {
    res.write(teil);
    await new Promise((r) => setTimeout(r, 2));
  }
}

// /v1/messages antwortet per SSE, ausser der Body verlangt stream:false (Ping) -> JSON.
function standardSzenario(pfad, body) {
  if (pfad !== '/v1/messages') return 'spiegel';
  try {
    return JSON.parse(body.toString('utf8')).stream === false ? 'json' : 'sse';
  } catch {
    return 'sse';
  }
}

async function antworte(req, res, body, url) {
  const szenario = url.searchParams.get('szenario') ?? standardSzenario(url.pathname, body);
  const allgemein = { 'request-id': 'req_fake_1', 'anthropic-ratelimit-requests-limit': '50' };
  switch (szenario) {
    case 'sse': {
      const roh = Buffer.from(SSE_TEXT, 'utf8');
      const mitGzip = url.searchParams.get('gzip') === '1';
      const daten = mitGzip ? await gzip(roh) : roh;
      res.writeHead(200, {
        ...allgemein,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        ...(mitGzip ? { 'content-encoding': 'gzip' } : {}),
      });
      await schreibeTeile(res, zerlege(daten));
      res.end();
      return;
    }
    case 'jsonteile': {
      // erst ein grosses Stueck Leerraum, dann ein kleines, fuer sich gueltiges JSON-Stueck
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(' '.repeat(100));
      await new Promise((r) => setTimeout(r, 30));
      res.end('{"usage":{"input_tokens":7}}');
      return;
    }
    case 'langsam': {
      await new Promise((r) => setTimeout(r, 400));
      if (res.destroyed || req.socket.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE_TEXT);
      return;
    }
    case 'abbruch': {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(Buffer.from(SSE_TEXT, 'utf8').subarray(0, 200));
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    case 'json': {
      const text = JSON.stringify(JSON_ANTWORT);
      res.writeHead(200, { ...allgemein, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
      return;
    }
    case 'fehler400':
    case 'fehler401':
    case 'fehler429':
    case 'fehler500': {
      const status = Number(szenario.slice(6));
      const text = fehlerJson(status === 401 ? 'authentication_error' : 'api_error', `Fake-Fehler ${status}`);
      res.writeHead(status, { ...allgemein, 'content-type': 'application/json', 'retry-after': '1' });
      res.end(text);
      return;
    }
    default: {
      const text = JSON.stringify({
        methode: req.method,
        pfad: req.url,
        kopfzeilen: req.headers,
        body: body.toString('utf8'),
        laenge: body.length,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(text);
    }
  }
}

export function starteFakeUpstream() {
  const anfragen = [];
  const server = http.createServer((req, res) => {
    const teile = [];
    req.on('data', (t) => teile.push(t));
    req.on('end', () => {
      const body = Buffer.concat(teile);
      const url = new URL(req.url, 'http://fake');
      anfragen.push({ methode: req.method, pfad: req.url, kopfzeilen: { ...req.headers }, body });
      antworte(req, res, body, url).catch(() => res.destroy());
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        anfragen,
        schliessen: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}
