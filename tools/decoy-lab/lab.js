import { createExample } from './fixtures/example.js';
import { renderLow } from './templates/low.js';
import { renderMedium } from './templates/medium.js';

const states = {
  low: [['catalog', 'Каталог документов'], ['empty', 'Пустой архив'], ['not-found', 'Не найдено'], ['unavailable', 'Материал недоступен']],
  medium: [['login', 'Вход'], ['login-error', 'Ошибка входа'], ['files', 'Список файлов'], ['file', 'Просмотр файла'], ['empty', 'Пустой каталог'], ['expired', 'Истёкшая сессия']]
};
const $ = id => document.getElementById(id);
let model = createExample();
let level = 'low';
let state = 'catalog';
let selectedDocumentId = model.documents[0].id;
let previewReady = false;
const preview = $('preview');

function options(select, items, selected) {
  select.replaceChildren(...items.map(([value, text]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    option.selected = value === selected;
    return option;
  }));
}

function syncDocumentEditor() {
  const item = model.documents.find(file => file.id === selectedDocumentId);
  options($('document'), model.documents.map(file => [file.id, file.title || 'Без названия']), selectedDocumentId);
  for (const input of document.querySelectorAll('[data-doc-field]')) input.value = item[input.dataset.docField];
}

function syncState() {
  options($('state'), states[level], state);
  $('state-help').textContent = level === 'medium' ? 'Демонстрационные экраны. Переключение не выполняет вход и не создаёт серверную сессию.' : 'Только статические ответы. Открытие материала покажет сообщение о недоступности.';
}

function changeState(next, message) {
  state = next;
  syncState();
  render();
  if (message) $('action-status').textContent = message;
}

function render() {
  $('preview-caption').textContent = (level === 'low' ? 'Low' : 'Medium') + ' · ' + states[level].find(item => item[0] === state)[1];
  if (!previewReady) return;
  const root = preview.contentDocument.getElementById('template-root');
  const previousFocus = preview.contentDocument.activeElement;
  const focusWasInTemplate = root.contains(previousFocus);
  const view = { ...model, state, selectedDocumentId };
  const handlers = {
    unavailable: () => changeState('unavailable', 'Low: показан статический ответ о недоступности.'),
    showCatalog: () => changeState('catalog', 'Открыт каталог Low.'),
    openFile: id => {
      selectedDocumentId = id;
      syncDocumentEditor();
      changeState('file', 'Открыт синтетический документ. Серверные действия не выполнялись.');
    },
    showFiles: () => changeState('files', 'Открыт демонстрационный список файлов.'),
    logout: () => changeState('login', 'Показан экран входа. Реальной сессии в лаборатории нет.')
  };
  (level === 'low' ? renderLow : renderMedium)(root, view, handlers);
  if (focusWasInTemplate) {
    const heading = root.querySelector('h1');
    heading.tabIndex = -1;
    heading.focus();
  }
}

for (const radio of document.querySelectorAll('[name="level"]')) {
  radio.addEventListener('change', () => {
    level = radio.value;
    changeState(states[level][0][0], 'Выбран шаблон ' + (level === 'low' ? 'Low.' : 'Medium. Вход демонстрационный.'));
  });
}
$('state').addEventListener('change', event => changeState(event.target.value, 'Состояние предпросмотра изменено.'));
for (const input of document.querySelectorAll('[data-field]')) {
  input.addEventListener('input', () => {
    model[input.dataset.field] = input.value;
    render();
  });
}
$('document').addEventListener('change', event => {
  selectedDocumentId = event.target.value;
  syncDocumentEditor();
  render();
});
for (const input of document.querySelectorAll('[data-doc-field]')) {
  input.addEventListener('input', () => {
    const item = model.documents.find(file => file.id === selectedDocumentId);
    item[input.dataset.docField] = input.value;
    if (input.dataset.docField === 'title') options($('document'), model.documents.map(file => [file.id, file.title || 'Без названия']), selectedDocumentId);
    render();
  });
}
$('width').addEventListener('change', event => {
  preview.style.width = event.target.value === 'fluid' ? '100%' : event.target.value + 'px';
  $('action-status').textContent = 'Ширина: ' + (event.target.value === 'fluid' ? 'по экрану.' : event.target.value + ' px, ограничена доступным местом.');
});
function reset() {
  model = createExample();
  level = 'low';
  state = 'catalog';
  selectedDocumentId = model.documents[0].id;
  for (const input of document.querySelectorAll('[data-field]')) input.value = model[input.dataset.field];
  document.querySelector('[name="level"][value="low"]').checked = true;
  $('width').value = 'fluid';
  preview.style.width = '100%';
  syncDocumentEditor();
  syncState();
  render();
  $('action-status').textContent = 'Исходный пример восстановлен.';
}
preview.addEventListener('load', () => {
  previewReady = true;
  render();
});
// The iframe can finish loading before the module and its listener.
if (preview.contentDocument?.getElementById('template-root')) previewReady = true;
$('reset').addEventListener('click', reset);
reset();
