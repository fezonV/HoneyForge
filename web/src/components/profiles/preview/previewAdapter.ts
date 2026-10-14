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
  const description = config.services?.[0]?.banner || '';

  const documents: PreviewDocument[] = (config.fake_fs || []).map((file, idx) => {
    const parts = file.path.split('/').filter(Boolean);
    const filename = parts.pop() || `doc-${idx + 1}.txt`;
    const rawSection = parts.length > 0 ? parts[parts.length - 1] : 'Общие документы';
    const section = rawSection.charAt(0).toUpperCase() + rawSection.slice(1);
    const cleanTitle = filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
    return {
      id: `file-${idx + 1}`,
      title: cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1),
      section,
      path: file.path,
      // ProfileConfig has no document dates. Do not invent metadata or content.
      date: '',
      body: file.content,
    };
  });

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
    loginNote: 'Макет формы входа. Переключайте состояния в панели предпросмотра выше.',
    loginPrompt: config.visible_texts?.login_prompt || 'Вход в архив',
    failureText: config.visible_texts?.failure || 'Неверные данные',
    successText: config.visible_texts?.success || '',
    sections,
    documents,
    state,
    selectedDocumentId,
  };
}
