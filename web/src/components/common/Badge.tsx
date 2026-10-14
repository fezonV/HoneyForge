import React from 'react';
import { InteractionLevel, TrapStatus, UserRole } from '../../api/types';



export const StatusBadge: React.FC<{ status: TrapStatus }> = ({ status }) => {
  const statusMap: Record<TrapStatus, { text: string; classes: string; dot: string }> = {
    online: {
      text: 'В сети',
      classes: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      dot: 'bg-emerald-500',
    },
    offline: {
      text: 'Не в сети',
      classes: 'bg-slate-100 text-slate-600 border-slate-200',
      dot: 'bg-slate-400',
    },
    last_seen: {
      text: 'Ожидает',
      classes: 'bg-blue-50 text-blue-700 border-blue-200',
      dot: 'bg-blue-500',
    },
    degraded: {
      text: 'Деградация',
      classes: 'bg-amber-50 text-amber-700 border-amber-200',
      dot: 'bg-amber-500',
    },
    unregistered: {
      text: 'Ожидает регистрации',
      classes: 'bg-rose-50 text-rose-700 border-rose-200',
      dot: 'bg-rose-500',
    },
  };

  const item = statusMap[status] || {
    text: status,
    classes: 'bg-slate-100 text-slate-600 border-slate-200',
    dot: 'bg-slate-400',
  };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border ${item.classes}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${item.dot}`} />
      {item.text}
    </span>
  );
};

export const LevelBadge: React.FC<{ level: InteractionLevel }> = ({ level }) => {
  const config = {
    low: {
      label: 'Low Interaction',
      classes: 'bg-sky-50 text-sky-700 border-sky-200',
    },
    medium: {
      label: 'Medium Interaction',
      classes: 'bg-amber-50 text-amber-800 border-amber-200',
    },
    high: {
      label: 'High Interaction (Sandbox)',
      classes: 'bg-purple-50 text-purple-700 border-purple-200',
    },
  }[level];

  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-semibold border ${config.classes}`}>
      {config.label}
    </span>
  );
};

export const RoleBadge: React.FC<{ role: UserRole }> = ({ role }) => {
  if (role === 'operator') {
    return (
      <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-brand-50 text-brand-700 border border-brand-200">
        Оператор (C2 Admin)
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-300">
      Наблюдатель (Viewer)
    </span>
  );
};

export const SeverityBadge: React.FC<{ severity: 'info' | 'warning' | 'critical' }> = ({ severity }) => {
  const config = {
    info: 'bg-slate-100 text-slate-700 border-slate-200',
    warning: 'bg-amber-50 text-amber-700 border-amber-200',
    critical: 'bg-rose-50 text-rose-700 border-rose-200 font-semibold',
  }[severity];

  const label = {
    info: 'Инфо',
    warning: 'Внимание',
    critical: 'Атака',
  }[severity];

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs border ${config}`}>
      {label}
    </span>
  );
};
