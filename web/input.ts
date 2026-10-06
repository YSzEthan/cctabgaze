// 把瀏覽器的 Pointer Events 與鍵盤輸入接到 gesture.ts（手勢狀態機）與 keys.ts（鍵盤差異比對），再經 send() 送給 host。
// 座標以 0 到 1 的比例傳，host 再換算成它自己的可視區；host 的 input() 會逐項檢查。
import { cancel, clampZoom, down, inside, move, newGesture, norm, pinch, releaseAll, snapZoom, up, wheelDelta, type Action, type Zoom } from './gesture.ts';
import { chunk, diff, SENTINEL } from './keys.ts';
import type { PageEv } from '../src/protocol.ts';

export interface Media { el: HTMLElement; nw: number; nh: number; vw?: number } // el：目前顯示的 img 或 video；nw、nh：畫面原始寬高；vw：host 可視區的 CSS 寬度
export interface InputDeps { send(ev: PageEv): void; media(): Media | null }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const mouse = (a: 'down' | 'up' | 'move', p: { x: number; y: number }, b: 'left' | 'none', n = 1): PageEv => ({ type: 'mouse', a, x: clamp01(p.x), y: clamp01(p.y), b, n, mod: 0 });
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const key = (a: 'down' | 'up', name: string, vk: number, text = ''): PageEv => ({ type: 'key', a, key: name, code: name, vk, text: a === 'down' ? text : '', mod: 0 });

export function initInput({ send, media }: InputDeps) {
  const stage = $('stage'), zoomEl = $('zoom'), kb = $<HTMLTextAreaElement>('kb'), kbBtn = $('kbd');
  const g = newGesture();
  let z: Zoom = { s: 1, tx: 0, ty: 0 };

  const rectOf = (m: Media) => m.el.getBoundingClientRect();
  const toNorm = (x: number, y: number, m: Media) => norm(x, y, rectOf(m), m.nw, m.nh);
  const applyZoom = (t: Zoom) => { z = t; zoomEl.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.s})`; };

  function run(actions: Action[]) {
    const m = media();
    for (const a of actions) {
      if (a.k === 'pinch') {
        const r = stage.getBoundingClientRect();
        applyZoom(pinch(z, a.ratio, a.cx - r.left, a.cy - r.top, a.dx, a.dy, { w: r.width, h: r.height }));
      } else if (a.k === 'pinchEnd') {
        const r = stage.getBoundingClientRect();
        applyZoom(clampZoom(snapZoom(z), { w: r.width, h: r.height }));
      } else if (m) {
        const r = rectOf(m), p = norm(a.x, a.y, r, m.nw, m.nh);
        if (!p) continue;
        if (a.k === 'click') { send(mouse('move', p, 'none')); send(mouse('down', p, 'left', a.n)); send(mouse('up', p, 'left', a.n)); }
        else if (a.k === 'wheel') { const d = (finger: number) => wheelDelta(finger, r, m.nw, m.nh, m.vw); send({ type: 'mouse', a: 'wheel', x: clamp01(p.x), y: clamp01(p.y), b: 'none', dx: d(a.dx), dy: d(a.dy), mod: 0 }); }
        else send(mouse(a.k, p, 'left'));
      }
    }
  }

  // 起點要落在畫面內（留白處不追蹤）；setPointerCapture：手指拖出元素外也收得到事件
  zoomEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return; // 桌面請用插件的 viewer
    const m = media();
    const a = document.activeElement;
    if (a instanceof HTMLInputElement) a.blur(); // 網址框有焦點時點畫面：touchstart 被擋掉所以焦點不會自己離開，使用者以為在 host 輸入，字卻進了網址框
    zoomEl.setPointerCapture(e.pointerId);
    run(down(g, e.pointerId, e.clientX, e.clientY, e.timeStamp, !!m && inside(toNorm(e.clientX, e.clientY, m))));
  });
  zoomEl.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse') run(move(g, e.pointerId, e.clientX, e.clientY, e.timeStamp)); });
  zoomEl.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') run(up(g, e.pointerId, e.timeStamp)); });
  zoomEl.addEventListener('pointercancel', (e) => run(cancel(g, e.pointerId)));
  // 擋掉長按選單、整頁縮放；touchstart 不取消的話，鍵盤開著時點畫面會讓 textarea 失去焦點、鍵盤收起
  zoomEl.addEventListener('contextmenu', (e) => e.preventDefault());
  zoomEl.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false }); // 只在畫面上：放在整個舞台會連 token 輸入框都點不進去
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  const release = () => run(releaseAll(g)); // 頁面隱藏、連線結束：按住中的要放開，否則 host 的滑鼠鍵會一直按著
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

  // ---- 鍵盤：「鍵盤」按鈕在點擊事件裡 focus（iOS 要求在使用者手勢內）----
  const reset = () => { kb.value = SENTINEL; kb.setSelectionRange(SENTINEL.length, SENTINEL.length); };
  function flush() { // 可重複呼叫：Safari 與 Chrome 誰先觸發事件都一樣，第二次比對不出差異就不送
    const out = diff(kb.value);
    reset();
    for (const o of out) {
      if (o.k === 'text') send({ type: 'text', text: o.text });
      else { const [name, vk, text] = o.k === 'back' ? ['Backspace', 8, ''] as const : ['Enter', 13, '\r'] as const; send(key('down', name, vk, text)); send(key('up', name, vk)); }
    }
  }
  kb.addEventListener('focus', reset);
  kb.addEventListener('input', (e) => { if (!(e as InputEvent).isComposing) flush(); });
  kb.addEventListener('compositionend', flush);
  kbBtn.addEventListener('pointerdown', (e) => e.preventDefault()); // 不拿走焦點
  kbBtn.addEventListener('click', () => { if (document.activeElement === kb) kb.blur(); else kb.focus(); });
  kb.addEventListener('focus', () => kbBtn.classList.add('on'));
  kb.addEventListener('blur', () => kbBtn.classList.remove('on'));

  // ---- 鍵盤開關時，版面高度跟著可視區（iOS 的鍵盤不會改變版面高度）----
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => { document.body.style.height = vv.height + 'px'; document.body.style.transform = `translateY(${vv.offsetTop}px)`; };
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit);
  }

  // 貼上：手機剪貼簿的文字整段當成「插入文字」送出（換行保留，單行輸入框會自己處理），超過長度上限就分段
  const typeText = (text: string) => { for (const t of chunk(text)) send({ type: 'text', text: t }); };

  return { release, typeText, resetZoom: () => applyZoom({ s: 1, tx: 0, ty: 0 }) };
}
