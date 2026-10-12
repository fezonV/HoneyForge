import { frame, introduction, empty, catalog, button, element, displayDate, fileSize } from './shared.js';

export function renderMedium(root, model, handlers = {}) {
  const signedIn = ['files', 'file', 'empty'].includes(model.state);
  const { doc, main } = frame(root, model, signedIn, handlers);
  if (['login', 'login-error', 'expired'].includes(model.state)) {
    const area = element(doc, 'section', undefined, 'login-panel');
    area.append(element(doc, 'h1', model.title), element(doc, 'p', model.description, 'description'));
    area.append(element(doc, 'h2', 'Вход в архив'));
    if (model.state !== 'login') {
      const message = element(doc, 'p', model.state === 'expired' ? 'Срок сессии истёк. Для продолжения требуется повторный вход.' : 'Не удалось войти. Проверьте имя пользователя и пароль.', 'login-message');
      message.setAttribute('role', 'alert');
      area.append(message);
    }
    for (const [name, title] of [['username', 'Имя пользователя'], ['password', 'Пароль']]) {
      const label = element(doc, 'label', title);
      const input = element(doc, 'input');
      input.id = 'archive-' + name;
      input.type = name === 'password' ? 'password' : 'text';
      input.readOnly = true;
      input.placeholder = name === 'password' ? 'Пароль' : 'Имя пользователя';
      input.setAttribute('aria-describedby', 'login-note');
      label.htmlFor = input.id;
      area.append(label, input);
    }
    const submit = element(doc, 'button', 'Войти', 'primary-button');
    submit.type = 'button';
    submit.disabled = true;
    const note = element(doc, 'p', 'Макет формы. Выберите состояние входа в настройках лаборатории.', 'login-note');
    note.id = 'login-note';
    area.append(submit, note);
    main.append(area);
    return;
  }
  introduction(doc, main, model);
  const back = () => button(doc, 'К списку файлов', () => handlers.showFiles?.(), 'quiet-button');
  if (model.state === 'empty') {
    empty(doc, main, 'Каталог пока пуст', 'В текущем каталоге нет опубликованных материалов.', back());
  } else if (model.state === 'file') {
    const item = model.documents.find(file => file.id === model.selectedDocumentId);
    if (!item) {
      empty(doc, main, 'Файл не найден', 'Выберите другой документ из каталога.', back());
      return;
    }
    const article = element(doc, 'article', undefined, 'file-view');
    article.append(back(), element(doc, 'p', item.path, 'view-path'), element(doc, 'h2', item.title), element(doc, 'p', displayDate(item.date) + ' · TXT · ' + fileSize(item.body), 'file-meta'), element(doc, 'pre', item.body, 'file-body'));
    main.append(article);
  } else {
    catalog(doc, main, model, id => handlers.openFile?.(id));
  }
}
