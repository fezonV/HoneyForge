import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Monitor,
  Tablet,
  Smartphone,
  Eye,
  RefreshCw,
  ShieldAlert,
  Folder,
  Key,
  Server,
} from 'lucide-react';
import { ProfileConfig } from '../../../api/types';
import { profileToPreviewModel } from './previewAdapter';
import { renderLow } from './templates/low';
import { renderMedium } from './templates/medium';
import archiveCss from './templates/archive.css?inline';

interface DecoyPreviewFrameProps {
  name: string;
  config: ProfileConfig;
}

type Viewport = 'desktop' | 'tablet' | 'mobile';

export const DecoyPreviewFrame: React.FC<DecoyPreviewFrameProps> = ({ name, config }) => {
  const isMedium = config.level === 'medium' || config.template_id === 'medium-http';
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [previewState, setPreviewState] = useState<string>(isMedium ? 'login' : 'catalog');
  const [selectedDocId, setSelectedDocId] = useState<string | undefined>(undefined);
  const [iframeReady, setIframeReady] = useState<boolean>(false);

  // Sync default state when level changes
  useEffect(() => {
    setPreviewState(isMedium ? 'login' : 'catalog');
    setSelectedDocId(undefined);
  }, [isMedium]);

  const previewModel = profileToPreviewModel(config, name, previewState, selectedDocId);

  const renderCurrentTemplate = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const doc = iframe.contentDocument;
    if (!doc) return;

    let root = doc.getElementById('template-root');
    if (!root) {
      doc.open();
      doc.write(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Предпросмотр архива</title>
  <style>${archiveCss}</style>
</head>
<body><div id="template-root"></div></body>
</html>`);
      doc.close();
      root = doc.getElementById('template-root');
    }

    if (!root) return;

    const handlers = {
      showCatalog: () => setPreviewState('catalog'),
      unavailable: () => setPreviewState('unavailable'),
      showFiles: () => setPreviewState('files'),
      openFile: (docId: string) => {
        setSelectedDocId(docId);
        setPreviewState('file');
      },
      logout: () => setPreviewState('login'),
    };

    if (isMedium) {
      renderMedium(root, previewModel, handlers);
    } else {
      renderLow(root, previewModel, handlers);
    }
  }, [isMedium, previewModel]);

  useEffect(() => {
    renderCurrentTemplate();
  }, [renderCurrentTemplate, iframeReady]);

  const viewportWidths: Record<Viewport, string> = {
    desktop: 'w-full',
    tablet: 'w-[768px]',
    mobile: 'w-[375px]',
  };

  const mediumStates = [
    { id: 'login', label: 'Вход' },
    { id: 'login-error', label: 'Ошибка входа' },
    { id: 'files', label: 'Файлы' },
    { id: 'expired', label: 'Истекла сессия' },
    { id: 'empty', label: 'Пустой каталог' },
  ];

  const lowStates = [
    { id: 'catalog', label: 'Каталог' },
    { id: 'empty', label: 'Пустой архив' },
    { id: 'unavailable', label: 'Недоступно' },
    { id: 'not-found', label: 'Не найдено' },
  ];

  const states = isMedium ? mediumStates : lowStates;

  return (
    <div className="space-y-4">
      {/* Top Banner Notice */}
      <div className="p-3 bg-brand-50 border border-brand-200 rounded-xl flex items-center justify-between flex-wrap gap-2 text-xs">
        <div className="flex items-center gap-2 text-brand-900 font-medium">
          <Eye className="w-4 h-4 text-brand-600 shrink-0" />
          <span>
            Безопасный предпросмотр шаблонов TL-01 ({config.level.toUpperCase()} / {config.template_id})
          </span>
        </div>
        <div className="flex items-center gap-3 text-brand-700 text-[11px]">
          <span className="flex items-center gap-1">
            <Server className="w-3.5 h-3.5" />
            Порт {config.services[0]?.port || 80}/HTTP
          </span>
          {isMedium && (
            <>
              <span className="flex items-center gap-1">
                <Folder className="w-3.5 h-3.5" />
                {config.fake_fs.length} файлов FS
              </span>
              <span className="flex items-center gap-1">
                <Key className="w-3.5 h-3.5" />
                {config.synthetic_credentials.length} кредов
              </span>
            </>
          )}
        </div>
      </div>

      {/* Control Bar */}
      <div className="bg-slate-100 p-2 rounded-xl border border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
        {/* State Selector */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-slate-500 font-medium px-1">Состояние:</span>
          {states.map((st) => (
            <button
              key={st.id}
              type="button"
              onClick={() => {
                setPreviewState(st.id);
                if (st.id === 'files') {
                  setSelectedDocId(undefined);
                }
              }}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                previewState === st.id
                  ? 'bg-brand-600 text-white shadow-2xs'
                  : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
              }`}
            >
              {st.label}
            </button>
          ))}
          {previewState === 'file' && (
            <span className="px-2 py-1 rounded-md text-xs font-semibold bg-amber-500 text-white shadow-2xs">
              Просмотр файла
            </span>
          )}
        </div>

        {/* Viewport Selector & Reset */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-white p-0.5 rounded-lg border border-slate-200">
            <button
              type="button"
              onClick={() => setViewport('desktop')}
              title="Десктоп (100%)"
              className={`p-1.5 rounded ${viewport === 'desktop' ? 'bg-slate-200 text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}
            >
              <Monitor className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewport('tablet')}
              title="Планшет (768px)"
              className={`p-1.5 rounded ${viewport === 'tablet' ? 'bg-slate-200 text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}
            >
              <Tablet className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewport('mobile')}
              title="Мобильный (375px)"
              className={`p-1.5 rounded ${viewport === 'mobile' ? 'bg-slate-200 text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}
            >
              <Smartphone className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setPreviewState(isMedium ? 'login' : 'catalog');
              setSelectedDocId(undefined);
              renderCurrentTemplate();
            }}
            title="Сбросить состояние"
            className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-slate-800"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Frame Container */}
      <div className="bg-slate-800/10 p-3 sm:p-4 rounded-xl border border-slate-200 flex justify-center overflow-x-auto min-h-[480px]">
        <div className={`${viewportWidths[viewport]} transition-all duration-300 shadow-lg rounded-xl overflow-hidden bg-white border border-slate-300`}>
          <div className="h-7 bg-slate-100 border-b border-slate-200 px-3 flex items-center justify-between text-[11px] text-slate-500 font-mono select-none">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-300 inline-block"></span>
              http://decoy.local:{config.services[0]?.port || 80}/
            </span>
            <span>Песочница предпросмотра TL-01</span>
          </div>

          <iframe
            ref={iframeRef}
            title="Decoy Template Live Preview"
            sandbox="allow-scripts allow-same-origin"
            onLoad={() => setIframeReady(true)}
            className="w-full h-[520px] border-0 bg-white"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-slate-500 px-1">
        <ShieldAlert className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span>
          Предпросмотр выполняется локально в изолированном iframe. Данные передаются через safe DOM TextContent. Сетевые запросы и события ловушки не порождаются.
        </span>
      </div>
    </div>
  );
};
