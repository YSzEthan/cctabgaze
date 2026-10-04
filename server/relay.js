// cctabgaze 轉接程式：只綁 127.0.0.1，檢視頁送來的任何訊息一律丟棄
const PORT = Number(process.env.CCTABGAZE_PORT || 17817);
const MAX_BUFFER = 4 * 1024 * 1024;
const viewerHtml = Bun.file(new URL('../viewer/index.html', import.meta.url));

const viewers = new Set();
let ext = null;
let lastFrame = null;

const hostOk = (host) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host || '');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const notifyViewers = () => { if (ext) ext.send(JSON.stringify({ type: 'viewers', n: viewers.size })); };

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    const host = req.headers.get('host');
    if (!hostOk(host)) return new Response('forbidden host', { status: 403 });
    const origin = req.headers.get('origin');
    if (url.pathname === '/view') {
      if (origin !== 'http://' + host) return new Response('forbidden origin', { status: 403 });
      return server.upgrade(req, { data: { role: 'view' } }) ? undefined : new Response('upgrade failed', { status: 400 });
    }
    if (url.pathname === '/ext') {
      if (!origin || !origin.startsWith('chrome-extension://')) return new Response('forbidden origin', { status: 403 });
      return server.upgrade(req, { data: { role: 'ext', origin } }) ? undefined : new Response('upgrade failed', { status: 400 });
    }
    if (url.pathname === '/') return new Response(viewerHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      if (ws.data.role === 'ext') { ext = ws; log('插件連線', ws.data.origin); notifyViewers(); }
      else { viewers.add(ws); log('檢視頁連線，共', viewers.size); notifyViewers(); if (lastFrame) ws.send(lastFrame); }
    },
    message(ws, msg) {
      if (ws.data.role !== 'ext') return; // 檢視頁的訊息全數丟棄
      const text = typeof msg === 'string' ? msg : new TextDecoder().decode(msg);
      let t; try { t = JSON.parse(text).type; } catch { return; }
      if (t === 'ping') return;
      if (t === 'frame') lastFrame = text;
      for (const v of viewers) {
        if (v.getBufferedAmount() > MAX_BUFFER) continue; // 流量控制：塞住的檢視頁跳過這一張
        v.send(text);
      }
    },
    close(ws) {
      if (ws.data.role === 'ext') { if (ext === ws) { ext = null; lastFrame = null; } log('插件斷線'); }
      else { viewers.delete(ws); log('檢視頁斷線，剩', viewers.size); notifyViewers(); }
    },
  },
});
log('relay 監聽 127.0.0.1:' + PORT);
