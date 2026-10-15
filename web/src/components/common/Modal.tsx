import React, { useRef, useId } from 'react';
import { useDialogFocus } from './useDialogFocus';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl';
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  maxWidth = 'md',
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(modalRef, isOpen, onClose);

  if (!isOpen) return null;

  const maxWidthClass = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-2xl',
  }[maxWidth];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-in fade-in"
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className={`bg-white rounded-xl shadow-xl border border-slate-200 w-full ${maxWidthClass} flex flex-col overflow-hidden animate-in zoom-in-95`}
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-100">
          <div>
            <h3 id={titleId} className="text-lg font-semibold text-slate-900">
              {title}
            </h3>
            {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 p-1.5 rounded-lg hover:bg-slate-100 transition-colors focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="Закрыть диалоговое окно"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[75vh]">{children}</div>

        {footer && (
          <div className="p-4 bg-slate-50 border-t border-slate-100 flex justify-end gap-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
