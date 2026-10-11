// Testhilfe (kein Test): eigener Prozess, der sich als Vermittler ausgibt.
// Aufruf: node attrappe-prozess.mjs <port> <verhalten> <version> <konfigHash>
//   port-zu-lebt: antwortet auf health; /_vermittler/stop schliesst den Port, der Prozess lebt weiter
//   haengt:       nimmt Verbindungen an und antwortet nie
import http from 'node:http';

const [port, verhalten, version, konfigHash] = process.argv.slice(2);

const server = http.createServer((req, res) => {
  if (verhalten === 'haengt') return;
  if (req.url === '/_vermittler/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, dienst: 'anthropic-vermittler', version, konfigHash, pid: process.pid }));
    return;
  }
  if (req.url === '/_vermittler/stop') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}', () => {
      server.closeAllConnections();
      server.close();
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(Number(port), '127.0.0.1', () => process.stdout.write('bereit\n'));
setInterval(() => {}, 60_000);
