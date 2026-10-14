import { PreviewModel, PreviewHandlers } from '../types';
import { frame, introduction, empty, catalog, button } from './shared';

export function renderLow(
  root: HTMLElement,
  model: PreviewModel,
  handlers: PreviewHandlers = {}
): void {
  const { doc, main } = frame(root, model, false, handlers);
  introduction(doc, main, model);
  const back = () =>
    button(doc, 'Вернуться в каталог', () => handlers.showCatalog?.(), 'primary-button');

  switch (model.state) {
    case 'empty':
      empty(
        doc,
        main,
        'Архив пока пуст',
        'Документы появятся после публикации архивной службой.',
        back()
      );
      break;
    case 'not-found':
      empty(
        doc,
        main,
        'Документ не найден',
        'Материал отсутствует в каталоге или был перемещён. Проверьте название документа.',
        back()
      );
      break;
    case 'unavailable':
      empty(
        doc,
        main,
        'Материал недоступен',
        'Эта копия архива публикует только каталог. Обратитесь в архивную службу за содержимым.',
        back()
      );
      break;
    default:
      catalog(doc, main, model, (id) => handlers.unavailable?.(id));
  }
}
