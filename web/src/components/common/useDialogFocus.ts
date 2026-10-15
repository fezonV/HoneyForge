import { RefObject, useEffect, useRef } from 'react';

let activeDialogs = 0;
let previousOverflow = '';

export function useDialogFocus(ref: RefObject<HTMLElement>, open: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const root = ref.current;
    if (!open || !root) return;
    if (activeDialogs++ === 0) previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const previous = document.activeElement as HTMLElement | null;
    const selector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';
    const focusable = () => Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((item) => item.getClientRects().length > 0);
    const timer = window.setTimeout(() => focusable()[0]?.focus(), 0);
    const handle = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== root) return;
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener('keydown', handle);
    return () => {
      if (--activeDialogs === 0) document.body.style.overflow = previousOverflow;
      window.clearTimeout(timer);
      window.removeEventListener('keydown', handle);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, ref]);
}
