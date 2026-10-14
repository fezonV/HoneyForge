import { ProfileConfig } from '../../../api/types';
import { PreviewModel, PreviewDocument } from './types';

/**
 * Adapter converting HoneyForge ProfileConfig into a PreviewModel
 * for TL-01 templates, without exposing real secrets.
 */
export function profileToPreviewModel(
  config: ProfileConfig,
  profileName: string,
  previewState?: string,
  selectedDocId?: string
): PreviewModel {
  const isMedium = config.level === 'medium' || config.template_id === 'medium-http';
  const orgName = config.visible_texts?.title?.trim() || profileName?.trim() || 'Ведомственный архив';
  const mainService =
    config.services?.[0]?.name?.trim() ||
    (isMedium ? 'Служебный портал' : 'Открытый каталог');
  const title = config.visible_texts?.title?.trim() || profileName?.trim() || 'Электронный архив';
  const description =
    config.visible_texts?.login_prompt?.trim() ||
    (isMedium
      ? 'Авторизация в закрытом служебном контуре ведомственного архива'
      : 'Публичный указатель открытых описей и документов архивного фонда');

  let documents: PreviewDocument[] = [];

  if (config.fake_fs && config.fake_fs.length > 0) {
    documents = config.fake_fs.map((file, idx) => {
      const parts = file.path.split('/').filter(Boolean);
      const filename = parts.pop() || `doc-${idx + 1}.txt`;
      const rawSection = parts.length > 0 ? parts[parts.length - 1] : 'Общие документы';
      const section = rawSection.charAt(0).toUpperCase() + rawSection.slice(1);
      const cleanTitle = filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
      const titleCap = cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);

      return {
        id: `file-${idx + 1}`,
        title: titleCap,
        section,
        path: file.path,
        date: '2026-09-01',
        body:
          file.content ||
          'Содержимое документа доступно только авторизованным сотрудникам архивного фонда.',
      };
    });
  } else {
    // Standard mock decoy catalog for Low or initial Medium preview
    documents = [
      {
        id: 'doc-01',
        title: 'Регламент доступа к архивному фонду',
        section: 'Регламенты',
        path: '/regulations/archive-rules.txt',
        date: '2026-08-10',
        body: 'Правила работы с документами ограниченного распространения. Версия 3.1.\nДоступ предоставляется на основании служебной записки.',
      },
      {
        id: 'doc-02',
        title: 'Отчёт об инвентаризации за III квартал',
        section: 'Отчёты',
        path: '/reports/inventory-q3.txt',
        date: '2026-09-01',
        body: 'Сводные данные инвентаризации архивных дел. Проверено 142 единицы хранения. Расхождений не обнаружено.',
      },
      {
        id: 'doc-03',
        title: 'Инструкция по передаче электронных дел',
        section: 'Регламенты',
        path: '/regulations/transfer-guide.txt',
        date: '2026-09-20',
        body: 'Порядок формирования описей и передачи электронных копий документов на долговременное хранение.',
      },
    ];
  }

  // Derive unique sections
  const sections = Array.from(new Set(documents.map((d) => d.section)));
  if (sections.length === 0) {
    sections.push('Каталог материалов');
  }

  // Determine active state
  let state = previewState || (isMedium ? 'login' : 'catalog');
  if (documents.length === 0 && (state === 'catalog' || state === 'files')) {
    state = 'empty';
  }

  const selectedDocumentId = selectedDocId || (documents[0]?.id ?? undefined);

  return {
    organization: orgName,
    service: mainService,
    title,
    description,
    sections,
    documents,
    state,
    selectedDocumentId,
  };
}
