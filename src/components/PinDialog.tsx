import { Delete, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { LoginResult } from '../consoleApi';
import { releasePointerFocus } from '../focus';

interface PinDialogProps {
  /** 交给后端验证；后端负责错误次数限制与锁定。 */
  onSubmit: (pin: string) => Promise<LoginResult>;
  onUnlock: () => void;
  onClose: () => void;
}

const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;

/** 进入设置前的 4 位管理密码弹窗；触屏用数字键盘，实体键盘可直接输入数字和退格。 */
export function PinDialog({ onSubmit, onUnlock, onClose }: PinDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function verify(pin: string) {
    setChecking(true);
    const result = await onSubmit(pin).catch((reason: Error) => ({ ok: false as const, message: reason.message }));
    setChecking(false);
    setValue('');
    if (result.ok) {
      dialogRef.current?.close();
      onUnlock();
    } else {
      setError(result.message);
    }
  }

  function press(key: (typeof keys)[number]) {
    if (checking) return;
    setError(null);
    if (key === 'clear') { setValue(''); return; }
    if (key === 'back') { setValue((previous) => previous.slice(0, -1)); return; }
    const next = (value + key).slice(0, 4);
    setValue(next);
    if (next.length === 4) void verify(next);
  }

  function handleKey(event: KeyboardEvent<HTMLDialogElement>) {
    if (/^\d$/.test(event.key)) { event.preventDefault(); press(event.key as (typeof keys)[number]); }
    else if (event.key === 'Backspace') { event.preventDefault(); press('back'); }
  }

  return (
    <dialog ref={dialogRef} className="device-dialog pin-dialog" aria-labelledby="pin-dialog-title" onKeyDown={handleKey} onClose={() => { onClose(); releasePointerFocus(); }}>
      <div className="device-dialog__heading">
        <div><small>设置</small><h2 id="pin-dialog-title">输入管理密码</h2></div>
        <button type="button" className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="取消"><X size={20} /></button>
      </div>
      <div className={`pin-dialog__dots${error ? ' pin-dialog__dots--error' : ''}`} aria-hidden="true">
        {[0, 1, 2, 3].map((index) => <span key={index} className={index < value.length ? 'pin-dialog__dot--filled' : undefined} />)}
      </div>
      <p className={`pin-dialog__hint${error ? ' pin-dialog__hint--error' : ''}`} role="status">{error ?? (checking ? '正在验证…' : `已输入 ${value.length} / 4 位`)}</p>
      <div className="pin-dialog__keypad">
        {keys.map((key) => (
          <button key={key} type="button" className={key === 'clear' || key === 'back' ? 'pin-dialog__key--secondary' : undefined} onClick={() => press(key)} disabled={checking} aria-label={key === 'clear' ? '清空' : key === 'back' ? '删除一位' : key}>
            {key === 'clear' ? '清空' : key === 'back' ? <Delete size={20} /> : key}
          </button>
        ))}
      </div>
    </dialog>
  );
}
