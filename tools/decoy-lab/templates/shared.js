export function element(doc, tag, text, className) {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function button(doc, text, action, className = '') {
  const node = element(doc, 'button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function frame(root, model, admin = false, handlers = {}) {
  const doc = root.ownerDocument;
  const page = element(doc, 'div', undefined, 'archive');
  const header = element(doc, 'header', undefined, 'archive-header');
  const identity = element(doc, 'div', undefined, 'archive-identity');
  identity.append(element(doc, 'span', model.organization.trim().charAt(0) || 'А', 'archive-mark'), element(doc, 'strong', model.organization));
  header.append(identity, element(doc, 'span', model.service, 'service-name'));
  if (admin && handlers.logout) header.append(button(doc, 'Выйти', handlers.logout, 'quiet-button'));
  const main = element(doc, 'main', undefined, 'archive-main');
  const footer = element(doc, 'footer', 'Архивная служба · ' + model.organization, 'archive-footer');
  page.append(header, main, footer);
  root.replaceChildren(page);
  return { doc, main };
}

export function introduction(doc, main, model) {
  main.append(element(doc, 'h1', model.title), element(doc, 'p', model.description, 'description'));
}

export function empty(doc, main, title, text, action) {
  const area = element(doc, 'section', undefined, 'empty-state');
  area.append(element(doc, 'span', '—', 'empty-mark'), element(doc, 'h2', title), element(doc, 'p', text));
  if (action) area.append(action);
  main.append(area);
}

export function fileSize(body) {
  const bytes = new TextEncoder().encode(body).length;
  return bytes < 1024 ? bytes + ' Б' : (bytes / 1024).toFixed(1).replace('.', ',') + ' КБ';
}

export function displayDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split('-').reverse().join('.') : date;
}

export function catalog(doc, main, model, open) {
  for (const section of model.sections) {
    const documents = model.documents.filter(item => item.section === section);
    const group = element(doc, 'section', undefined, 'document-group');
    const heading = element(doc, 'div', undefined, 'group-heading');
    heading.append(element(doc, 'h2', section), element(doc, 'span', documents.length + ' док.', 'count'));
    group.append(heading);
    for (const item of documents) {
      const row = element(doc, 'div', undefined, 'document-row');
      const name = element(doc, 'div', undefined, 'document-name');
      name.append(button(doc, item.title || 'Без названия', () => open(item.id), 'file-button'), element(doc, 'span', item.path, 'file-path'));
      row.append(element(doc, 'span', 'TXT', 'file-type'), name, element(doc, 'time', displayDate(item.date), 'file-date'), element(doc, 'span', fileSize(item.body), 'file-size'));
      group.append(row);
    }
    if (!documents.length) group.append(element(doc, 'p', 'В этом разделе пока нет документов.', 'section-empty'));
    main.append(group);
  }
}
