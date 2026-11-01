// The small banner that asks for the LAN pairing code (game/apiFetch.ts): shown only when an /api request was refused for want
// of the code. The code is kept in this browser; nothing else is asked here.
import { useEffect, useState, type FormEvent } from 'react';
import { PAIR_PROMPT, onPairNeeded, setPairCode } from '../game/apiFetch';
import './PairBanner.css';

export function PairBanner() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  useEffect(() => onPairNeeded(() => setOpen(true)), []);
  if (!open) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = code.trim();
    if (!t) return;
    setPairCode(t);
    setCode('');
    setOpen(false);
    location.reload();
  };
  return (
    <form className="pair-banner" role="alert" onSubmit={submit}>
      <label className="pair-banner-label">
        <span>{PAIR_PROMPT}</span>
        <input type="password" value={code} onChange={(e) => setCode(e.target.value)} maxLength={64} autoComplete="off" autoCapitalize="none"
          spellCheck={false} aria-label="配對碼" />
      </label>
      <button type="submit" disabled={!code.trim()}>送出</button>
    </form>
  );
}
