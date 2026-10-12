import { AlertCircle, FolderOpen, RefreshCw, Lock } from 'lucide-react';
import { Button } from './Button';

export const LoadingSkeleton: React.FC<{ rows?: number }> = ({ rows = 4 }) => {
  return (
    <div className="space-y-3 p-4 animate-pulse">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4 items-center">
          <div className="h-4 bg-slate-200 rounded w-1/4"></div>
          <div className="h-4 bg-slate-200 rounded w-1/3"></div>
          <div className="h-4 bg-slate-200 rounded w-1/6"></div>
          <div className="h-4 bg-slate-200 rounded w-1/6"></div>
        </div>
      ))}
    </div>
  );
};

export const EmptyState: React.FC<{
  title: string;
  description: string;
  actionText?: string;
  onAction?: () => void;
  icon?: React.ReactNode;
}> = ({ title, description, actionText, onAction, icon }) => {
  return (
    <div className="flex flex-col items-center justify-center p-12 text-center bg-white rounded-xl border border-slate-200 my-4">
      <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 mb-3">
        {icon || <FolderOpen className="w-6 h-6" />}
      </div>
      <h3 className="text-base font-semibold text-slate-900 mb-1">{title}</h3>
      <p className="text-sm text-slate-500 max-w-md mb-4">{description}</p>
      {actionText && onAction && (
        <Button variant="outline" size="sm" onClick={onAction}>
          {actionText}
        </Button>
      )}
    </div>
  );
};

export const ErrorState: React.FC<{
  title?: string;
  message: string;
  code?: string;
  onRetry?: () => void;
}> = ({ title = 'Ошибка загрузки данных', message, code, onRetry }) => {
  return (
    <div className="p-6 bg-rose-50 border border-rose-200 rounded-xl my-4 text-rose-900">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-6 h-6 text-rose-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <h4 className="font-semibold text-base text-rose-900">{title}</h4>
          <p className="text-sm text-rose-850 mt-1">{message}</p>
          {code && (
            <p className="text-xs font-mono text-rose-600 mt-1">Код ошибки: {code}</p>
          )}
          {onRetry && (
            <div className="mt-4">
              <Button
                variant="outline"
                size="sm"
                leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
                onClick={onRetry}
                className="bg-white hover:bg-rose-100/50 text-rose-900 border-rose-300"
              >
                Повторить попытку
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const ViewerReadOnlyBanner: React.FC = () => {
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-xs text-amber-900 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Lock className="w-3.5 h-3.5 text-amber-700 flex-shrink-0" />
        <span>
          <strong>Режим наблюдателя (Viewer):</strong> Доступен только просмотр телеметрии и логов. Изменение профилей, генерация токенов и отправка команд отключены.
        </span>
      </div>
      <span className="font-semibold text-amber-800 uppercase tracking-wider text-[11px]">Read-Only</span>
    </div>
  );
};
