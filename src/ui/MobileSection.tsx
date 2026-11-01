import { useEffect, useState } from 'react';
import { apiFetch } from '../game/apiFetch';

type Status = { model: string; requests: number; limit: number; day: string };
export function MobileSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [install, setInstall] = useState(false);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    void apiFetch('/api/mobile/status').then(r => r.ok ? r.json() : null).then(setStatus).catch(() => {}).finally(() => setLoading(false));
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return <section className="mobile-settings">
    <h3>手機版連線</h3>
    <p>OpenAI API · {status?.model ?? (loading ? '連線檢查中…' : '尚未連線，請檢查設定與網路')}</p>
    <p>{offline ? '目前離線。可查看這台手機的紀錄；AI 對話需要網路。' : '直接連接雲端，不需要電腦開機。'}</p>
    {status && <p>今日已使用 {status.requests}／{status.limit} 次。台灣時間午夜重計；速查、練習判斷與失敗請求也計入。</p>}
    <p>AI 用量另外計費，不包含在 ChatGPT Plus 月費裡。語音使用手機內建功能。</p>
    <p>對話、錯題與圖片存在這台裝置；清除網站資料會移除紀錄。對話文字會送到 OpenAI 取得回覆。</p>
    <button className="as-small" onClick={() => setInstall(!install)}>加入主畫面</button>
    {install && <p>iPhone／iPad：Safari 分享 → 加入主畫面。Android：Chrome 選單 → 安裝應用程式或加入主畫面。</p>}
    <form method="post" action="/auth/logout"><button className="as-small" type="submit">登出這台裝置</button></form>
  </section>;
}
