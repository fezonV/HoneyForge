import { ProfileConfig, PreviewModel, PreviewDocument } from '../api/types';

/**
 * Adapter converting HoneyForge ProfileConfig into a safe PreviewModel
 * for Decoy Lab (TL-01) template rendering without exposing real secrets.
 */
export function profileToPreviewModel(
  config: ProfileConfig,
  profileName: string,
  previewState?: string,
  selectedDocId?: string
): PreviewModel {
  const isMedium = config.level === 'medium' || config.template_id === 'medium-http';
  const mainService = config.services[0]?.name || (isMedium ? 'Служебный портал' : 'Открытый каталог');
  const orgName = config.visible_texts.title || profileName || 'Ведомственный архив';

  // Construct preview documents from fake_fs if provided, or default decoy documents
  let documents: PreviewDocument[] = [];

  if (config.fake_fs && config.fake_fs.length > 0) {
    documents = config.fake_fs.map((f, idx) => {
      const parts = f.path.split('/').filter(Boolean);
      const filename = parts.pop() || `doc-${idx + 1}.txt`;
      const section = parts.length > 0 ? parts[parts.length - 1].toUpperCase() : 'ОБЩИЕ ДОКУМЕНТЫ';
      const cleanTitle = filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');

      return {
        id: `doc-${idx + 1}`,
        title: cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1),
        section,
        path: f.path,
        date: '2026-09-15',
        body: f.content || 'Содержимое документа доступно только авторизованным сотрудникам архивного фонда.',
      };
    });
  } else {
    // Standard mock decoy catalog for Low or initial Medium preview
    documents = [
      {
        id: 'doc-01',
        title: 'Регламент доступа к архивному фонду',
        section: 'РЕГЛАМЕНТЫ',
        path: '/regulations/archive-rules.txt',
        date: '2026-08-10',
        body: 'Правила работы с документами ограниченного распространения. Версия 3.1.\nДоступ предоставляется на основании служебной записки.',
      },
      {
        id: 'doc-02',
        title: 'Отчёт об инвентаризации за III квартал',
        section: 'ОТЧЁТЫ',
        path: '/reports/inventory-q3.txt',
        date: '2026-09-01',
        body: 'Сводные данные инвентаризации архивных дел. Проверено 142 единицы хранения. Расхождений не обнаружено.',
      },
      {
        id: 'doc-03',
        title: 'Инструкция по передаче электронных дел',
        section: 'РЕГЛАМЕНТЫ',
        path: '/regulations/transfer-guide.txt',
        date: '2026-09-20',
        body: 'Порядок формирования описей и передачи электронных копий документов на долговременное хранение.',
      },
    ];
  }

  // Derive unique sections
  const sections = Array.from(new Set(documents.map((d) => d.section)));
  if (sections.length === 0) {
    sections.push('КАТАЛОГ МАТЕРИАЛОВ');
  }

  // Determine active state
  let state = previewState || (isMedium ? 'login' : 'catalog');
  if (documents.length === 0 && state === 'catalog') {
    state = 'empty';
  }

  return {
    organization: orgName,
    service: mainService,
    title: config.visible_texts.title || profileName || 'Электронный архив',
    description:
      config.visible_texts.login_prompt ||
      (isMedium
        ? 'Авторизация в закрытом служебном контуре ведомственного архива'
        : 'Публичный указатель открытых описей и документов архивного фонда'),
    sections,
    documents,
    state,
    selectedDocumentId: selectedDocId || (documents[0]?.id ?? undefined),
  };
}
