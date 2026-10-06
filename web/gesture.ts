// 觸控手勢狀態機，不碰 DOM、不用計時器（時間由呼叫端傳入），所以可以直接用 bun 測。
// 單指：輕點＝點擊（連點＝雙擊）、拖＝捲動、長按後拖＝按住拖曳。雙指：縮放與平移（只在本機，不傳給 host）。
// 輸出的座標都是螢幕座標（clientX／clientY），換成 host 的比例座標與捲動距離由 input.ts 做。

export const SLOP = 8, LONG_MS = 450, DBL_MS = 300, DBL_PX = 30, THROTTLE_MS = 33, MAX_ZOOM = 5;

export type Action =
  | { k: 'click'; x: number; y: number; n: 1 | 2 }
  | { k: 'down' | 'move' | 'up'; x: number; y: number } // 拖曳：down 在起點、move 節流、up 帶最後位置
  | { k: 'wheel'; x: number; y: number; dx: number; dy: number } // x、y：按下的起點；dx、dy：手指累計位移（螢幕像素，手指往下＝正）
  | { k: 'pinch'; ratio: number; cx: number; cy: number; dx: number; dy: number } // 雙指：縮放倍率變化、中點、中點位移
  | { k: 'pinchEnd' };

interface Ptr { x0: number; y0: number; x: number; y: number; t0: number }
export interface Gesture {
  mode: 'idle' | 'pending' | 'scroll' | 'drag' | 'zoom';
  ptrs: Map<number, Ptr>;
  lastTap: { t: number; x: number; y: number } | null;
  accX: number; accY: number; // scroll 還沒送出的累計位移
  prevXY: { x: number; y: number }; // scroll 上一次處理的位置
  lastOut: number; // 上一次送出 wheel／move 的時間
  prevPinch: { dist: number; cx: number; cy: number } | null;
}
export const newGesture = (): Gesture => ({ mode: 'idle', ptrs: new Map(), lastTap: null, accX: 0, accY: 0, prevXY: { x: 0, y: 0 }, lastOut: -Infinity, prevPinch: null });

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
function pinchOf(g: Gesture) {
  const [a, b] = [...g.ptrs.values()];
  return a && b ? { dist: Math.max(1, dist(a, b)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 } : null;
}

// 離開目前模式要補的動作：拖曳中就放開按鍵，捲動中未送出的累計丟掉
function leave(g: Gesture): Action[] {
  const out: Action[] = [];
  if (g.mode === 'drag') { const p = [...g.ptrs.values()][0]; if (p) out.push({ k: 'up', x: p.x, y: p.y }); }
  g.accX = g.accY = 0;
  return out;
}

export function down(g: Gesture, id: number, x: number, y: number, t: number, inside: boolean): Action[] {
  if (g.ptrs.has(id)) return [];
  if (g.mode === 'zoom' || g.ptrs.size === 1) { // 第二根以上的手指：進入縮放，一直維持到所有手指放開（已經在縮放時 leave 不會有輸出）
    const out = leave(g);
    g.mode = 'zoom';
    g.ptrs.set(id, { x0: x, y0: y, x, y, t0: t });
    g.prevPinch = pinchOf(g);
    return out;
  }
  if (!inside) return []; // 起點在畫面留白處：不追蹤
  g.ptrs.set(id, { x0: x, y0: y, x, y, t0: t });
  g.mode = 'pending';
  g.prevXY = { x, y };
  return [];
}

export function move(g: Gesture, id: number, x: number, y: number, t: number): Action[] {
  const p = g.ptrs.get(id);
  if (!p) return [];
  p.x = x; p.y = y;
  if (g.mode === 'zoom') {
    const now = pinchOf(g), prev = g.prevPinch;
    g.prevPinch = now;
    return now && prev ? [{ k: 'pinch', ratio: now.dist / prev.dist, cx: now.cx, cy: now.cy, dx: now.cx - prev.cx, dy: now.cy - prev.cy }] : [];
  }
  if (g.mode === 'pending' && dist(p, { x: p.x0, y: p.y0 }) > SLOP) {
    if (t - p.t0 >= LONG_MS) { g.mode = 'drag'; g.lastOut = t; return [{ k: 'down', x: p.x0, y: p.y0 }, { k: 'move', x, y }]; }
    g.mode = 'scroll';
    g.prevXY = { x: p.x0, y: p.y0 };
    g.lastOut = -Infinity;
  }
  if (g.mode === 'scroll') {
    g.accX += x - g.prevXY.x; g.accY += y - g.prevXY.y;
    g.prevXY = { x, y };
    return flushWheel(g, p, t);
  }
  if (g.mode === 'drag' && t - g.lastOut >= THROTTLE_MS) { g.lastOut = t; return [{ k: 'move', x, y }]; }
  return [];
}

function flushWheel(g: Gesture, p: Ptr, t: number, force = false): Action[] {
  if ((!g.accX && !g.accY) || (!force && t - g.lastOut < THROTTLE_MS)) return [];
  const a: Action = { k: 'wheel', x: p.x0, y: p.y0, dx: g.accX, dy: g.accY }; // 座標固定用按下的起點，手指滑到別的捲動區域也還是捲同一個
  g.accX = g.accY = 0; g.lastOut = t;
  return [a];
}

function liftZoom(g: Gesture, id: number): Action[] { // 縮放中放開一根手指；全部放開才結束（途中放開一指不退回其他模式）
  g.ptrs.delete(id);
  g.prevPinch = null;
  if (g.ptrs.size) return [];
  g.mode = 'idle';
  return [{ k: 'pinchEnd' }];
}

export function up(g: Gesture, id: number, t: number): Action[] {
  const p = g.ptrs.get(id);
  if (!p) return [];
  let out: Action[] = [];
  if (g.mode === 'zoom') return liftZoom(g, id);
  if (g.mode === 'pending') { // 沒超過門檻：點擊（長按沒移動也算點擊）
    const l = g.lastTap, dbl = !!l && t - l.t <= DBL_MS && dist(l, p) <= DBL_PX;
    g.lastTap = dbl ? null : { t, x: p.x, y: p.y };
    out = [{ k: 'click', x: p.x, y: p.y, n: dbl ? 2 : 1 }];
  } else if (g.mode === 'scroll') out = flushWheel(g, p, t, true);
  else if (g.mode === 'drag') out = [{ k: 'up', x: p.x, y: p.y }];
  g.ptrs.delete(id);
  g.mode = 'idle';
  return out;
}

// pointercancel：系統手勢、來電等。不產生點擊，拖曳中要放開按鍵
export function cancel(g: Gesture, id: number): Action[] {
  if (!g.ptrs.has(id)) return [];
  if (g.mode === 'zoom') return liftZoom(g, id);
  const out = leave(g);
  g.ptrs.delete(id);
  g.mode = 'idle';
  return out;
}

// 頁面隱藏、連線結束：不管現在什麼狀態，按住中的就放開
export function releaseAll(g: Gesture): Action[] {
  const out = leave(g);
  const wasZoom = g.mode === 'zoom';
  g.ptrs.clear(); g.mode = 'idle'; g.prevPinch = null;
  return wasZoom ? [...out, { k: 'pinchEnd' }] : out;
}

// ---- 幾何：全部是純函式 ----
export interface Rect { left: number; top: number; width: number; height: number }

// 螢幕座標 → 畫面內的 0 到 1 比例。rect 是 img／video 元素的框（已含縮放），nw、nh 是畫面原始寬高；扣掉 object-fit: contain 的留白
export function norm(x: number, y: number, r: Rect, nw: number, nh: number) {
  if (!nw || !nh) return null;
  const k = Math.min(r.width / nw, r.height / nh), w = nw * k, h = nh * k;
  return { x: (x - r.left - (r.width - w) / 2) / w, y: (y - r.top - (r.height - h) / 2) / h };
}
export const inside = (p: { x: number; y: number } | null) => !!p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;

// 手指位移（螢幕像素）→ host 的 wheel 位移（CSS 像素）。截圖是裝置像素，所以不能用截圖寬度；vw 是 host 可視區的 CSS 寬度，舊版 host 沒有就假設 1 倍
export function wheelDelta(finger: number, r: Rect, nw: number, nh: number, vw?: number) {
  const shown = nw * Math.min(r.width / nw, r.height / nh); // 畫面實際顯示的寬度（螢幕像素）
  return -finger * ((vw || nw) / shown);
}

// 縮放變換：t 是 { s, tx, ty }（transform-origin 在左上角），box 是 #zoom 在 scale 1 時的寬高，(cx, cy) 是相對於它的雙指中點
export interface Zoom { s: number; tx: number; ty: number }
export function pinch(t: Zoom, ratio: number, cx: number, cy: number, dx: number, dy: number, box: { w: number; h: number }): Zoom {
  const s = Math.min(MAX_ZOOM, Math.max(1, t.s * ratio)), f = s / t.s;
  return clampZoom({ s, tx: cx - (cx - t.tx) * f + dx, ty: cy - (cy - t.ty) * f + dy }, box);
}
export function clampZoom(t: Zoom, box: { w: number; h: number }): Zoom {
  return { s: t.s, tx: Math.min(0, Math.max(box.w - box.w * t.s, t.tx)), ty: Math.min(0, Math.max(box.h - box.h * t.s, t.ty)) };
}
export const snapZoom = (t: Zoom): Zoom => (t.s < 1.05 ? { s: 1, tx: 0, ty: 0 } : t); // 縮回接近 1 倍就貼齊
