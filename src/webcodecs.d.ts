// lib.dom 還沒有的 Chrome API；cgStream 是 offscreen 文件把收到的視訊串流掛在 window 上，檢視頁用 chrome.extension.getViews() 取用
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'video' });
  readonly writable: WritableStream<VideoFrame>;
}
interface Window { cgStream?: MediaStream }
