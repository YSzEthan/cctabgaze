// host 端的信令連線：連到自架的中繼伺服器，等 viewer（手機 PWA）的 offer。設定存在這台的 storage.local（不同步）。
// MV3 背景程式閒置約 30 秒會休眠：每 20 秒送 ping、伺服器回 pong（有訊息往來才會延長壽命），斷線後 5 秒重連，並用 alarms 保底喚醒。
import { slog, errText } from './shared.ts';
import type { Reply } from './protocol.ts';

export interface SignalConfig { url: string; token: string }
export interface SignalOffer { id: string; sdp: string }
const ALARM = 'cg_signal', BEAT_MS = 20000, RETRY_MS = 5000, MAX_SDP = 32768;

export const parseSignalUrl = (s: unknown): string | null => {
  try { const u = new URL(String(s)); return u.protocol === 'ws:' || u.protocol === 'wss:' ? u.href : null; } catch { return null; }
};

// 驗證並儲存設定（懸浮視窗與安裝說明頁共用），回傳要顯示給使用者的訊息
export async function saveSignal(url: string, token: string): Promise<string> {
  if (!url && !token) { await chrome.storage.local.remove('signal'); return '已清除，不連線'; }
  if (!parseSignalUrl(url)) return '位址要以 ws:// 或 wss:// 開頭，未儲存';
  if (token.length < 24) return 'token 至少 24 字元，未儲存';
  await chrome.storage.local.set({ signal: { url, token } });
  return '已儲存，馬上連線';
}

export function startSignal(onOffer: (o: SignalOffer, reply: Reply) => void) {
  let ws: WebSocket | null = null, cfg: SignalConfig | null = null, beat: ReturnType<typeof setInterval> | undefined, retry: ReturnType<typeof setTimeout> | undefined;

  const close = () => { clearInterval(beat); clearTimeout(retry); const w = ws; ws = null; if (w) { w.onclose = null; w.close(); } };

  async function sync() {
    const { role = 'host', signal } = await chrome.storage.local.get<{ role: string; signal: Partial<SignalConfig> }>(['role', 'signal']);
    const url = parseSignalUrl(signal?.url), token = signal?.token;
    if (role !== 'host' || !url || typeof token !== 'string' || !token) { cfg = null; return close(); }
    if (ws && cfg?.url === url && cfg.token === token && ws.readyState <= WebSocket.OPEN) return; // 已經連著（或正在連）
    close();
    cfg = { url, token };
    open(cfg);
  }

  function open(c: SignalConfig) {
    const w = ws = new WebSocket(c.url);
    w.onopen = () => {
      if (w !== ws) return;
      w.send(JSON.stringify({ type: 'hello', token: c.token }));
      beat = setInterval(() => { if (w.readyState === WebSocket.OPEN) w.send('{"type":"ping"}'); }, BEAT_MS);
    };
    w.onmessage = (e) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.type === 'ready') return void slog('[信令] 已連上伺服器');
      if (m.type !== 'offer' || typeof m.id !== 'string' || m.id.length > 64 || typeof m.sdp !== 'string' || m.sdp.length > MAX_SDP) return;
      const id = m.id;
      onOffer({ id, sdp: m.sdp }, async (body) => {
        if (w.readyState !== WebSocket.OPEN) throw new Error('信令連線已斷');
        w.send(JSON.stringify(body.error ? { type: 'error', id, error: body.error } : { type: 'answer', id, sdp: body.sdp }));
      });
    };
    w.onerror = () => {}; // 細節在 onclose 處理
    w.onclose = () => {
      if (w !== ws) return;
      ws = null; clearInterval(beat);
      slog('[信令] 連線中斷，5 秒後重連');
      retry = setTimeout(() => sync().catch((e) => slog('[信令] 重連失敗：', errText(e))), RETRY_MS);
    };
  }

  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) sync().catch(() => {}); });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.role || ch.signal)) sync().catch(() => {}); });
  sync().catch((e) => slog('[信令] 啟動失敗：', errText(e)));
}
