// 安裝說明頁：第一次安裝插件時由背景程式自動開啟。插件不能執行本機的腳本，所以只列出要執行的指令，並讓 host 在這裡填信令伺服器的設定
import { saveSignal } from './signal.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
$('sigsave').onclick = async () => { $('sigmsg').textContent = await saveSignal($<HTMLInputElement>('sigurl').value.trim(), $<HTMLInputElement>('sigtoken').value.trim()); };
