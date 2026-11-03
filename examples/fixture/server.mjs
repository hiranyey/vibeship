// One tiny app built into several fixture images (see scripts/fixtures.sh).
// MODE picks the behavior:
//   hello      serves 200 on /health
//   crash      exits right after starting
//   unhealthy  runs but answers 500 on /health
//   slow       answers 503 on /health for SLOW_SECONDS (default 45), then 200
//   probe      reports which internal addresses it can reach
import { createServer } from 'node:http';

const mode = process.env.MODE ?? 'hello';
const version = process.env.VERSION ?? 'v1';
const started = Date.now();

if (mode === 'crash') {
  console.error('crash fixture: exiting with code 1');
  setTimeout(() => process.exit(1), 200);
}

/** Tries each address the probe fixture checks; none but the open web should work. */
async function probe() {
  const targets = {
    'caddy-api:2019': 'http://caddy-api:2019/config/',
    'caddy:2019': 'http://caddy:2019/config/',
    '172.31.250.2:2019': 'http://172.31.250.2:2019/config/',
    'vibeship:3000': 'http://vibeship:3000/healthz',
  };
  const results = {};
  for (const [name, url] of Object.entries(targets)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      results[name] = `reachable: HTTP ${res.status}`;
    } catch (err) {
      results[name] = err.cause?.code ?? err.name;
    }
  }
  return results;
}

createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' });
    res.end(typeof body === 'string' ? `${body}\n` : JSON.stringify(body));
  };

  if (req.url === '/health') {
    if (mode === 'unhealthy') return send(500, 'unhealthy on purpose');
    const slowFor = Number(process.env.SLOW_SECONDS ?? 45) * 1000;
    if (mode === 'slow' && Date.now() - started < slowFor) return send(503, 'still starting');
    return send(200, 'ok');
  }
  if (req.url?.startsWith('/env/')) {
    const key = decodeURIComponent(req.url.slice('/env/'.length));
    return key in process.env ? send(200, { value: process.env[key] }) : send(404, { error: `${key} is not set` });
  }
  if (mode === 'probe') return send(200, await probe());
  send(200, `hello from ${version} (${mode})`);
}).listen(Number(process.env.PORT ?? 8080), () => console.log(`fixture ${mode} ${version} listening`));
