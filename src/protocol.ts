// 各個執行環境之間傳的訊息（只有型別，編譯後是空的）。
// chrome.runtime 的訊息用 target 指定收件者；DataChannel 上的訊息見最下面兩段。
export type AiState = 'running' | 'permission' | 'done' | 'idle';
export type Format = 'jpeg' | 'webp' | 'png';
export type EndReason = 'ai-ended' | 'replaced' | 'host-canceled' | 'answer-failed' | 'viewer-left';
export type Mode = 'video' | 'image'; // video：截圖餵進視訊編碼器走 WebRTC 視訊軌；image：逐張 JPEG 走 DataChannel（備案）
export interface Tune { quality: number; fast: number; format: Format; mode: Mode }
export interface TabInfo { id: number | undefined; title: string; url: string }

// ---- storage.sync 上的握手 ----
export interface Req { id: string; from: string; t: number; sdp: string }
export interface Res { to: string; id: string; t: number; sdp?: string; error?: string }

// ---- DataChannel：viewer → host。host 端一律當成不可信的資料，在 input()、tune()、doControl() 逐項檢查 ----
export type Button = 'left' | 'middle' | 'right' | 'none';
export type PageEv =
  | { type: 'mouse'; a: 'down' | 'up' | 'move' | 'wheel'; x: number; y: number; b?: Button; n?: number; dx?: number; dy?: number; mod: number }
  | { type: 'key'; a: 'down' | 'up'; key: string; code: string; vk: number; text: string; mod: number }
  | { type: 'text'; text: string }
  | { type: 'copy' };
export type CtlEv =
  | { type: 'nav'; a: 'go' | 'back' | 'forward' | 'reload'; url?: string; tabId: number }
  | { type: 'tab'; a: 'auto' | 'open' }
  | { type: 'tab'; a: 'select' | 'close'; tabId: number };
export type InputEv = (PageEv & { tabId: number }) | CtlEv | ({ type: 'tune' } & Tune);
export type Untrusted = Record<string, unknown>;

// ---- DataChannel：host → viewer。畫面是一筆 h 標頭加若干二進位區塊 ----
export type CtlMsg =
  | { type: 'same'; state: AiState }
  | { type: 'error'; message: string }
  | { type: 'copied'; text: string }
  | { type: 'tabs'; cur: number | null; pinned: boolean; tabs: TabInfo[] };
export interface FrameHead { type: 'h'; chunks: number; state: AiState; tabId: number; ts: number; fmt: Format }
export interface VideoHead { type: 'v'; state: AiState; tabId: number; ts: number } // 視訊模式：像素在視訊軌裡，這筆只帶中繼資料
export type EndMsg = { type: 'end'; reason: EndReason };
export type HostWire = FrameHead | VideoHead | CtlMsg | EndMsg;

// ---- → 背景程式 ----
type FromHostOff = // host 端 offscreen 送的，一律帶連線編號
  | { type: 'input'; ev: unknown }
  | { type: 'answer'; sdp: string }
  | { type: 'answer-failed'; reason?: string }
  | { type: 'open'; video: boolean } // video：視訊軌協商成功且和 DataChannel 走同一條連線
  | { type: 'video-failed' } // 本機編碼壞了，之後只走圖片
  | { type: 'ready'; seq: number }
  | { type: 'closed' };
type FromViewerOff = // viewer 端 offscreen 送的
  | { type: 'v-offer'; sdp: string; kept: number }
  | { type: 'v-connected' }
  | { type: 'v-closed'; connected: boolean }
  | { type: 'v-pagegone' }
  | { type: 'v-netfail'; detail: string };
export type HostUp = FromHostOff;
export type ViewerUp = FromViewerOff | { type: 'log'; line: string };
export type SwMsg = { target: 'sw'; id?: string } & (FromHostOff | FromViewerOff | { type: 'log'; line: string } | { type: 'idle' } | { type: 'v-connect' });

// ---- 背景程式 → host 端 offscreen ----
export type OffBody =
  | EndMsg
  | { type: 'frame'; b64: string; state: AiState; tabId: number; ts: number; seq: number; fmt: Format; video: boolean }
  | { type: 'ctl'; msg: CtlMsg }
  | { type: 'reset' };
export type OfferMsg = { target: 'offscreen'; type: 'offer'; id: string; sdp: string; nets: unknown };
export type OffMsg = OfferMsg | ({ target: 'offscreen'; id?: string } & OffBody);

// ---- → viewer 端 offscreen ----
export type VoffBody =
  | { type: 'start'; id: string; nets: unknown }
  | { type: 'answer'; id: string; sdp: string }
  | { type: 'stop'; id?: string }
  | { type: 'input'; ev: InputEv }
  | { type: 'resend' };
export type VoffMsg = { target: 'voff' } & VoffBody;

// ---- viewer 端 offscreen → 檢視頁面（背景程式也聽，用來更新狀態文字）----
export type ViewBody =
  | { type: 'frame'; src?: string; state: AiState; ts: number; tabId: number } // 沒有 src：像素在視訊串流裡
  | CtlMsg
  | EndMsg;
export type ViewMsg = { target: 'viewer' } & ViewBody;

export type Msg = SwMsg | OffMsg | VoffMsg | ViewMsg;
