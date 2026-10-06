// 信令中繼：只有一個 host（新連線取代舊的）。viewer 的 offer 轉給 host，等 host 回 answer 再原路回傳。不解析 SDP。
// 純邏輯、不依賴 Bun 的 API，方便單獨測。
export interface Sock { send(data: string): void; close(): void }
export type Answer = { sdp: string } | { error: string };

export class Relay {
  host: Sock | null = null;
  waiting = new Map<string, (a: Answer) => void>();
  ttl: number;
  constructor(ttl = 20000) { this.ttl = ttl; }

  attach(s: Sock) { // 新 host 取代舊的：host 的背景程式重連時，舊連線可能還沒被判定斷線，不能拒絕新的
    const old = this.host;
    this.host = s;
    if (old && old !== s) { this.failAll('host-restarted'); try { old.close(); } catch {} }
  }
  detach(s: Sock) {
    if (this.host !== s) return;
    this.host = null;
    this.failAll('host-offline');
  }

  offer(sdp: string): Promise<Answer> {
    const host = this.host;
    if (!host) return Promise.resolve({ error: 'host-offline' });
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve({ error: 'timeout' }); }, this.ttl);
      this.waiting.set(id, (a) => { clearTimeout(timer); this.waiting.delete(id); resolve(a); });
      try { host.send(JSON.stringify({ type: 'offer', id, sdp })); } catch { this.waiting.get(id)?.({ error: 'host-offline' }); }
    });
  }

  fromHost(s: Sock, raw: string) {
    if (s !== this.host) return;
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'ping') return s.send('{"type":"pong"}');
    if ((m.type !== 'answer' && m.type !== 'error') || typeof m.id !== 'string') return;
    const done = this.waiting.get(m.id);
    if (!done) return;
    if (m.type === 'answer' && typeof m.sdp === 'string') done({ sdp: m.sdp });
    else done({ error: typeof m.error === 'string' ? m.error.slice(0, 64) : 'failed' });
  }

  failAll(error: string) { for (const done of [...this.waiting.values()]) done({ error }); }
}
