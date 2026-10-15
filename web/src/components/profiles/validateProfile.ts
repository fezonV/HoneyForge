import { ProfileConfig } from '../../api/types';

const bytes = (value: string | undefined) => new TextEncoder().encode(value || '').length;
export const mandatoryCategories = (level: string) => ['connection.opened', 'http.request', ...(level === 'medium'
  ? ['auth.attempt', 'session.started', 'file.listed', 'file.read', 'file.downloaded', 'session.ended'] : [])];

export function fieldStep(key: string): number {
  if (key.startsWith('services')) return 2;
  if (/^(visible_texts|synthetic_credentials|fake_fs)/.test(key)) return 3;
  if (/^(channel|logging)/.test(key)) return 4;
  return 1;
}

export function validateProfile(name: string, description: string, config: ProfileConfig): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!name.trim() || bytes(name.trim()) > 120) errors.name = 'Введите название до 120 байт UTF-8';
  if (bytes(description) > 2000) errors.description = 'Описание должно быть до 2000 байт UTF-8';
  if (!config.services.length || config.services.length > 16) errors.services = 'Нужно от 1 до 16 сервисов';
  const ids = new Set<string>(), ports = new Set<number>();
  config.services.forEach((service, i) => {
    const prefix = `services[${i}]`;
    if (!service.id || bytes(service.id) > 64 || ids.has(service.id)) errors[`${prefix}.id`] = 'Требуется уникальный ID до 64 байт';
    if (!service.name.trim() || bytes(service.name) > 100) errors[`${prefix}.name`] = 'Введите имя до 100 байт';
    if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535 || ports.has(service.port)) errors[`${prefix}.port`] = 'Укажите уникальный целый порт от 1 до 65535';
    if (service.protocol !== 'http') errors[`${prefix}.protocol`] = 'Поддерживается только HTTP';
    if (bytes(service.banner || '') > 4096) errors[`${prefix}.banner`] = 'Баннер должен быть до 4096 байт';
    ids.add(service.id || ''); ports.add(service.port);
  });
  Object.entries(config.visible_texts).forEach(([key, value]) => {
    if (bytes(value) > 4096) errors[`visible_texts.${key}`] = 'Текст должен быть до 4096 байт';
  });
  if (config.synthetic_credentials.length > 100) errors.synthetic_credentials = 'Не более 100 учётных записей';
  config.synthetic_credentials.forEach((credential, i) => {
    if (!credential.username.trim() || bytes(credential.username) > 128 || bytes(credential.password) > 256) errors[`synthetic_credentials[${i}]`] = 'Логин: 1–128 байт; пароль: до 256 байт';
  });
  if (config.fake_fs.length > 200) errors.fake_fs = 'Не более 200 файлов';
  const paths = new Set<string>();
  config.fake_fs.forEach((file, i) => {
    if (!file.path || bytes(file.path) > 256 || Array.from(file.path).some((char) => char === '\\' || char === ':' || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || file.path.split('/').some((part) => !part || part === '.' || part === '..') || paths.has(file.path)) {
      errors[`fake_fs[${i}].path`] = 'Нужен уникальный относительный путь без пустых частей, . и ..';
    }
    if (bytes(file.content) > 65536) errors[`fake_fs[${i}].content`] = 'Содержимое должно быть до 65536 байт';
    paths.add(file.path);
  });
  if (!config.channel.tls_required) errors['channel.tls_required'] = 'TLS обязателен';
  if (!Number.isInteger(config.channel.heartbeat_seconds) || config.channel.heartbeat_seconds < 5 || config.channel.heartbeat_seconds > 300) errors['channel.heartbeat_seconds'] = 'Heartbeat: целое число от 5 до 300 секунд';
  if (!Number.isInteger(config.channel.sync_seconds) || config.channel.sync_seconds < 1 || config.channel.sync_seconds > 3600) errors['channel.sync_seconds'] = 'Синхронизация: целое число от 1 до 3600 секунд';
  if (mandatoryCategories(config.level).some((category) => !config.logging.categories.includes(category))) errors['logging.categories'] = 'Обязательные категории нельзя отключать';
  return errors;
}
