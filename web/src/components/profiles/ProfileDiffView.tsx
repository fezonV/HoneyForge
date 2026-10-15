import React from 'react';
import { ProfileConfig } from '../../api/types';

interface Props {
  baseTitle?: string;
  newTitle?: string;
  baseConfig: ProfileConfig;
  newConfig: ProfileConfig;
}

// Public revisions deliberately omit passwords. Equal redacted values cannot
// prove equal secrets; never render passwords in a configuration diff.
function visibleFields(config: ProfileConfig) {
  const fields: Record<string, string> = {
    'Шаблон': config.template_id, 'Уровень': config.level,
    'Логирование': config.logging.categories.join(', '),
    'Heartbeat': String(config.channel.heartbeat_seconds), 'Sync': String(config.channel.sync_seconds),
    'TLS': config.channel.tls_required ? 'обязателен' : 'отключён',
    'Учётные записи': config.synthetic_credentials.map((item) => item.username).join(', '),
  };
  Object.entries(config.visible_texts).forEach(([key, value]) => { fields[`Текст ${key}`] = value; });
  config.services.forEach((service) => {
    fields[`Сервис ${service.id}`] = `${service.name}: ${service.protocol}:${service.port}; ${service.banner || ''}`;
  });
  config.fake_fs.forEach((file) => { fields[`Файл ${file.path}`] = file.content; });
  return fields;
}

export const ProfileDiffView: React.FC<Props> = ({ baseTitle = 'Базовая версия', newTitle = 'Новая версия', baseConfig, newConfig }) => {
  const before = visibleFields(baseConfig), after = visibleFields(newConfig);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => before[key] !== after[key]);
  return <div className="space-y-3 text-xs">
    <p className="text-slate-500">Синтетические пароли скрыты и не сравниваются.</p>
    {changed.length === 0 ? <p>Видимые параметры конфигураций совпадают.</p> :
      <table className="w-full table-fixed border-collapse" aria-label="Различия версий профиля">
        <thead><tr><th>Параметр</th><th>{baseTitle}</th><th>{newTitle}</th></tr></thead>
        <tbody>{changed.map((key) => <tr key={key} className="border-t align-top">
          <th className="p-2 break-words text-left">{key}</th>
          {[before[key], after[key]].map((value, index) => <td key={index} className="p-2 whitespace-pre-wrap break-words">
            {value === undefined ? 'Отсутствует' : value === '' ? '(пусто)' : value.slice(0, 4096)}
            {value && value.length > 4096 && '… (показаны первые 4096 символов)'}
          </td>)}
        </tr>)}</tbody>
      </table>}
  </div>;
};
