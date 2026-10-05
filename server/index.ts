// 信令伺服器（Bun）：POST /offer 給 viewer，/ws 給 host，其餘是手機網頁（PWA）的靜態檔。
// 環境變數：CG_TOKEN（必填，至少 24 字元）、PORT（預設 8790）、WEB_DIR（網頁所在資料夾，預設是和 server/ 同層的 web/）
// 只該跑在 Tailscale 內（用 tailscale serve 加 HTTPS）；token 是唯一的認證，伺服器本身等同完全信任，見 README。
import { createHash, timingSafeEqual } from 'node:crypto';
import { Relay } from './relay.ts';

const token = process.env.CG_TOKEN ?? '';
if (token.length < 24) { console.error('需要環境變數 CG_TOKEN（至少 24 字元，例如 openssl rand -hex 24）'); process.exit(1); }
const port = Number(process.env.PORT ?? 8790);
const MAX_SDP = 32768, HELLO_MS = 5000;

const digest = (s: string) => createHash('sha256').update(s).digest();
const sameToken = (s: string) => timingSafeEqual(digest(s), digest(token)); // 先雜湊成等長，才能做常數時間比較
const relay = new Relay();

// 靜態檔只開放這幾個（固定名單，不依請求的路徑組檔名）。網頁本身沒有秘密，不需要 token；token 只擋 /offer 與 /ws
const webDir = process.env.WEB_DIR ?? `${import.meta.dir}/../web`;
const STATIC: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};

interface WsData { authed: boolean; timer?: ReturnType<typeof setTimeout> }

const server = Bun.serve<WsData>({
  port,
  idleTimeout: 30, // POST /offer 要等 host 回 answer，最長 20 秒；預設 10 秒會先被切斷
  maxRequestBodySize: MAX_SDP + 1024,
  async fetch(req, srv) {
    const { pathname } = new URL(req.url);
    if (pathname === '/ws') return srv.upgrade(req, { data: { authed: false } }) ? undefined : new Response('upgrade failed', { status: 400 });
    if (pathname === '/offer' && req.method === 'POST') {
      const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
      if (!m?.[1] || !sameToken(m[1])) return new Response('unauthorized', { status: 401 });
      const body: unknown = await req.json().catch(() => null);
      const sdp = body && typeof body === 'object' && 'sdp' in body ? body.sdp : null;
      if (typeof sdp !== 'string' || !sdp || sdp.length > MAX_SDP) return new Response('bad request', { status: 400 });
      return Response.json(await relay.offer(sdp));
    }
    const asset = req.method === 'GET' ? STATIC[pathname] : undefined;
    if (asset) {
      const f = Bun.file(`${webDir}/${asset[0]}`);
      if (await f.exists()) return new Response(f, { headers: { 'content-type': asset[1], 'cache-control': 'no-cache' } });
    }
    return new Response('not found', { status: 404 });
  },
  websocket: {
    maxPayloadLength: MAX_SDP + 1024,
    open(ws) { ws.data.timer = setTimeout(() => { if (!ws.data.authed) ws.close(); }, HELLO_MS); },
    message(ws, msg) {
      const text = typeof msg === 'string' ? msg : msg.toString();
      if (ws.data.authed) return relay.fromHost(ws, text);
      let t: unknown;
      try { const m = JSON.parse(text); t = m?.type === 'hello' ? m.token : null; } catch {}
      if (typeof t !== 'string' || !sameToken(t)) return ws.close();
      ws.data.authed = true;
      clearTimeout(ws.data.timer);
      relay.attach(ws);
      ws.send('{"type":"ready"}');
      console.log('host 已連上');
    },
    close(ws) { clearTimeout(ws.data.timer); relay.detach(ws); if (ws.data.authed) console.log('host 離線'); },
  },
});
console.log(`信令伺服器：port ${server.port}`);
