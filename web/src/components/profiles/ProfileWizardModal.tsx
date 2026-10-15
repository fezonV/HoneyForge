import React, { useState, useEffect, useRef } from 'react';
import { X, ChevronLeft, ChevronRight, Check, Rocket, Shield } from 'lucide-react';
import {
  Profile,
  ProfileRevision,
  ProfileConfig,
  ServiceConfig,
  VisibleTexts,
  SyntheticCredential,
  FakeFile,
  ChannelConfig,
} from '../../api/types';
import { api } from '../../api/client';
import { useNotification } from '../../context/NotificationContext';
import { Step1TemplateLevel } from './wizard/Step1TemplateLevel';
import { Step2ServicesPorts } from './wizard/Step2ServicesPorts';
import { Step3BehaviorData } from './wizard/Step3BehaviorData';
import { Step4LoggingChannel } from './wizard/Step4LoggingChannel';
import { Step5ReviewPreview } from './wizard/Step5ReviewPreview';
import { Button } from '../common/Button';
import { useDialogFocus } from '../common/useDialogFocus';
import { validateProfile, fieldStep, mandatoryCategories } from './validateProfile';
import { ProfileConflictModal } from './ProfileConflictModal';

const DEFAULT_SERVICES: ServiceConfig[] = [
  {
    id: 'svc-http-1',
    name: 'Public Archive Gateway',
    port: 80,
    protocol: 'http',
    banner: 'nginx/1.24.0 (Ubuntu)',
  },
];

const DEFAULT_VISIBLE_TEXTS: VisibleTexts = {
  title: 'Ведомственный электронный архив',
  login_prompt: 'Каталог открытых фондов и служебных описей',
  success: 'Доступ разрешён. Загрузка фонда...',
  failure: 'Неверные учётные данные или доступ ограничен',
};

const DEFAULT_CREDENTIALS: SyntheticCredential[] = [
  { username: 'admin', password: 'AdminPassword2026!' },
  { username: 'operator', password: 'Operator#Secure99' },
];

const DEFAULT_FAKE_FS: FakeFile[] = [
  {
    path: 'regulations/archive-rules.txt',
    content: 'Регламент доступа к архивному фонду. Утверждён приказом № 42-А.\nВсе действия пользователей логируются.',
  },
  {
    path: 'reports/quarterly-review-q3.txt',
    content: 'Квартальный отчёт инвентаризации документов.\nВсего проверено: 154 дела.\nНарушений не выявлено.',
  },
  {
    path: 'notes/reader-guide.txt',
    content: 'Инструкция для исследователей по заказу архивных описей и электронных копий.',
  },
];

const DEFAULT_CATEGORIES: string[] = [
  'connection.opened',
  'http.request',
  'auth.attempt',
  'session.started',
  'file.listed',
  'file.read',
  'file.downloaded',
  'session.ended',
];

const DEFAULT_CHANNEL: ChannelConfig = {
  tls_required: true,
  heartbeat_seconds: 15,
  sync_seconds: 30,
};

interface ProfileWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProfileCreated?: (profile: Profile) => void;
  onProfileUpdated?: (profile: Profile) => void;
  onDeployInstance?: (profile: Profile, revision?: number) => void;
  initialProfile?: Profile | null;
}

export const ProfileWizardModal: React.FC<ProfileWizardModalProps> = ({
  isOpen,
  onClose,
  onProfileCreated,
  onProfileUpdated,
  onDeployInstance,
  initialProfile,
}) => {
  const { notify } = useNotification();
  const isEditMode = !!initialProfile;

  const [currentStep, setCurrentStep] = useState<number>(1);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [createdProfile, setCreatedProfile] = useState<Profile | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [currentBaseRevision, setCurrentBaseRevision] = useState<number>(initialProfile?.revision || 1);

  // Conflict state
  const [conflictOpen, setConflictOpen] = useState<boolean>(false);
  const [serverProfile, setServerProfile] = useState<Profile | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, isOpen && !conflictOpen, () => { if (!isSubmitting) onClose(); });
  const [serverRevision, setServerRevision] = useState<ProfileRevision | null>(null);

  // Form State
  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [templateId, setTemplateId] = useState<'low-http' | 'medium-http'>('low-http');
  const [services, setServices] = useState<ServiceConfig[]>(DEFAULT_SERVICES);
  const [visibleTexts, setVisibleTexts] = useState<VisibleTexts>(DEFAULT_VISIBLE_TEXTS);
  const [credentials, setCredentials] = useState<SyntheticCredential[]>(DEFAULT_CREDENTIALS);
  const [fakeFs, setFakeFs] = useState<FakeFile[]>(DEFAULT_FAKE_FS);
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [channel, setChannel] = useState<ChannelConfig>(DEFAULT_CHANNEL);

  // Reset or fill state on open / initialProfile change
  useEffect(() => {
    if (!isOpen) return;

    if (initialProfile) {
      setName(initialProfile.name);
      setDescription(initialProfile.description || '');
      setCurrentBaseRevision(initialProfile.revision || 1);

      const cfg = initialProfile.config;
      if (cfg) {
        setTemplateId(
          (cfg.template_id as 'low-http' | 'medium-http') ||
            (initialProfile.level === 'medium' ? 'medium-http' : 'low-http')
        );
        setServices(cfg.services && cfg.services.length > 0 ? [...cfg.services] : [...DEFAULT_SERVICES]);
        setVisibleTexts(cfg.visible_texts ? { ...cfg.visible_texts } : DEFAULT_VISIBLE_TEXTS);
        setCredentials(cfg.synthetic_credentials ? [...cfg.synthetic_credentials] : DEFAULT_CREDENTIALS);
        setFakeFs(cfg.fake_fs ? [...cfg.fake_fs] : DEFAULT_FAKE_FS);
        setCategories(cfg.logging?.categories ? [...cfg.logging.categories] : DEFAULT_CATEGORIES);
        setChannel(cfg.channel ? { ...cfg.channel } : DEFAULT_CHANNEL);
      } else {
        setTemplateId(initialProfile.level === 'medium' ? 'medium-http' : 'low-http');
        setServices(
          initialProfile.services && initialProfile.services.length > 0
            ? [...initialProfile.services]
            : DEFAULT_SERVICES
        );
        setVisibleTexts(DEFAULT_VISIBLE_TEXTS);
        setCredentials(DEFAULT_CREDENTIALS);
        setFakeFs(DEFAULT_FAKE_FS);
        setCategories(DEFAULT_CATEGORIES);
        setChannel(DEFAULT_CHANNEL);
      }
    } else {
      setName('');
      setDescription('');
      setTemplateId('low-http');
      setServices(DEFAULT_SERVICES);
      setVisibleTexts(DEFAULT_VISIBLE_TEXTS);
      setCredentials(DEFAULT_CREDENTIALS);
      setFakeFs(DEFAULT_FAKE_FS);
      setCategories(DEFAULT_CATEGORIES);
      setChannel(DEFAULT_CHANNEL);
      setCurrentBaseRevision(1);
    }

    setCurrentStep(1);
    setCreatedProfile(null);
    setErrors({});
    setConflictOpen(false);
    setServerRevision(null);
    setServerProfile(null);
  }, [isOpen, initialProfile]);

  if (!isOpen) return null;

  const isMedium = templateId === 'medium-http';
  const level = isMedium ? 'medium' : 'low';

  // Construct current ProfileConfig
  const currentConfig: ProfileConfig = {
    template_id: templateId,
    level,
    services,
    visible_texts: visibleTexts,
    synthetic_credentials: isMedium ? credentials : [],
    fake_fs: isMedium ? fakeFs : [],
    logging: { categories: [...new Set([...mandatoryCategories(level), ...categories])] },
    channel,
  };

  const validateStep = (step: number): boolean => {
    const invalid = Object.fromEntries(Object.entries(validateProfile(name, description, currentConfig)).filter(([key]) => fieldStep(key) === step));
    setErrors(invalid);
    return Object.keys(invalid).length === 0;
  };

  const handleNext = () => {
    if (validateStep(currentStep)) {
      setCurrentStep((prev) => Math.min(prev + 1, 5));
    }
  };

  const handleBack = () => {
    setErrors({});
    setCurrentStep((prev) => Math.max(prev - 1, 1));
  };

  const handleSave = async (overrideBaseRevision?: number) => {
    const invalid = validateProfile(name, description, currentConfig);
    if (Object.keys(invalid).length) {
      setErrors(invalid);
      setCurrentStep(Math.min(...Object.keys(invalid).map(fieldStep)));
      return;
    }

    setIsSubmitting(true);
    try {
      if (isEditMode && initialProfile) {
        const baseRev = overrideBaseRevision ?? currentBaseRevision;
        const result = await api.profiles.patch(initialProfile.id, {
          base_revision: baseRev,
          name: name.trim(),
          description: description.trim() || 'Профиль приманки HoneyForge',
          config: currentConfig,
        });

        setCurrentBaseRevision(result.profile.revision);
        setCreatedProfile(result.profile);
        onProfileUpdated?.(result.profile);
        notify(
          'success',
          'Профиль обновлён',
          `Создана новая ревизия v${result.profile.revision} профиля "${result.profile.name}"`
        );
      } else {
        const created = await api.profiles.create({
          name: name.trim(),
          description: description.trim() || 'Профиль приманки HoneyForge',
          config: currentConfig,
        });

        setCreatedProfile(created);
        onProfileCreated?.(created);
        notify('success', 'Профиль сохранён', `Профиль "${created.name}" (rev ${created.revision}) создан в реестре`);
      }
    } catch (err: any) {
      if (
        err.status === 409 &&
        (err.code === 'revision_conflict' || err.message?.includes('изменён') || err.message?.includes('conflict'))
      ) {
        try {
          const latest = (await api.profiles.get(initialProfile!.id)).profile;
          const revision = await api.profiles.sensitiveRevision(latest.id, latest.revision);
          setServerProfile(latest);
          setServerRevision(revision);
        } catch (cause) {
          setErrors({ name: cause instanceof Error ? cause.message : 'Не удалось загрузить актуальную версию; черновик сохранён' });
          setCurrentStep(1);
          return;
        }
        setConflictOpen(true);
        notify(
          'warning',
          'Конфликт ревизий',
          'Профиль был изменён на сервере другим пользователем. Ваш черновик сохранён. Выберите способ разрешения конфликта.'
        );
        return;
      }

      if (err.field_errors) {
        setErrors(err.field_errors);
        setCurrentStep(Math.min(...Object.keys(err.field_errors).map(fieldStep)));
      }
      notify('error', 'Ошибка сохранения профиля', err.message || 'Сервер отклонил конфигурацию');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleApplyOverServer = async (newBaseRev: number) => {
    setCurrentBaseRevision(newBaseRev);
    setConflictOpen(false);
    await handleSave(newBaseRev);
  };

  const handleAcceptServer = () => {
    if (!serverRevision) return;
    setCurrentBaseRevision(serverRevision.revision);
    if (serverProfile) { setName(serverProfile.name); setDescription(serverProfile.description || ''); }
    const cfg = serverRevision.config;
    if (cfg) {
      setTemplateId(
        (cfg.template_id as 'low-http' | 'medium-http') || (cfg.level === 'medium' ? 'medium-http' : 'low-http')
      );
      setServices([...cfg.services]);
      setVisibleTexts({ ...cfg.visible_texts });
      setCredentials([...(cfg.synthetic_credentials || [])]);
      setFakeFs([...(cfg.fake_fs || [])]);
      setCategories([...(cfg.logging?.categories || [])]);
      setChannel({ ...cfg.channel });
    }
    setConflictOpen(false);
    notify('info', 'Ревизия сервера принята', `Черновик синхронизирован с ревизией v${serverRevision.revision}`);
  };

  const handleSaveAsCopy = async () => {
    setConflictOpen(false);
    setIsSubmitting(true);
    try {
      const copy = await api.profiles.create({
        name: `${Array.from(name.trim()).slice(0, 24).join('')} (копия)`,
        description: description.trim() ? `${description.trim()} (копия)` : 'Копия профиля приманки',
        config: currentConfig,
      });
      setCreatedProfile(copy);
      onProfileCreated?.(copy);
      notify('success', 'Черновик сохранён как копия', `Создан отдельный профиль "${copy.name}" (v1)`);
    } catch (err: any) {
      notify('error', 'Ошибка сохранения копии', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const stepsList = [
    { num: 1, title: 'Шаблон и уровень' },
    { num: 2, title: 'Сервисы и порты' },
    { num: 3, title: 'Поведение и данные' },
    { num: 4, title: 'Логирование и канал' },
    { num: 5, title: 'Проверка и предпросмотр' },
  ];

  return (
    <>
      <div
        ref={dialogRef}
        aria-labelledby="profile-wizard-title"
        className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5"
        role="dialog"
        aria-modal="true"
      >
        <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-5xl flex flex-col max-h-[92vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200">
          {/* Modal Header */}
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/60">
            <div>
              <h1 id="profile-wizard-title" className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
                <Shield className="w-5 h-5 text-brand-600" />
                {isEditMode
                  ? `Редактирование профиля: ${initialProfile.name} (базовая v${currentBaseRevision})`
                  : 'Конструктор профиля поведения (Profile Wizard)'}
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                {isEditMode
                  ? 'Сохранение создаст новую ревизию с сохранением истории и контролем конфликтов (FR-C2)'
                  : 'Пошаговое создание профиля приманки с серверной валидацией контракта BE-01 (FR-C1)'}
              </p>
            </div>

            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded-lg transition-colors cursor-pointer"
              title="Закрыть"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {Object.keys(errors).length > 0 && <div role="alert" className="px-6 py-3 text-sm text-rose-700">{Object.entries(errors).map(([key, message]) => <p key={key}>{key}: {message}</p>)}</div>}

          {/* Wizard Stepper Progress Bar */}
          {!createdProfile && (
            <div className="px-6 py-3 bg-white border-b border-slate-200/80 overflow-x-auto">
              <div className="flex items-center justify-between min-w-[580px] gap-2">
                {stepsList.map((s, idx) => {
                  const isActive = currentStep === s.num;
                  const isPassed = currentStep > s.num;

                  return (
                    <React.Fragment key={s.num}>
                      <button
                        type="button"
                        onClick={() => {
                          if (isPassed) setCurrentStep(s.num);
                        }}
                        disabled={!isPassed && !isActive}
                        className={`flex items-center gap-2 text-xs font-semibold py-1 px-2 rounded-lg transition-colors ${
                          isActive
                            ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-500/30'
                            : isPassed
                            ? 'text-slate-800 hover:bg-slate-100 cursor-pointer'
                            : 'text-slate-400 cursor-not-allowed opacity-70'
                        }`}
                      >
                        <span
                          className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold ${
                            isActive
                              ? 'bg-brand-600 text-white'
                              : isPassed
                              ? 'bg-emerald-600 text-white'
                              : 'bg-slate-200 text-slate-500'
                          }`}
                        >
                          {isPassed ? <Check className="w-3 h-3" /> : s.num}
                        </span>
                        <span>{s.title}</span>
                      </button>

                      {idx < stepsList.length - 1 && (
                        <div className="flex-1 h-0.5 bg-slate-200 min-w-[16px]" />
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          )}

          {/* Modal Scrollable Body */}
          <div className="flex-1 overflow-y-auto p-6">
            {createdProfile ? (
              /* Success Completion Screen */
              <div className="text-center py-10 space-y-6 max-w-lg mx-auto">
                <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto">
                  <Check className="w-8 h-8 stroke-[2.5]" />
                </div>

                <div>
                  <h2 className="text-xl font-bold text-slate-900">
                    {isEditMode ? 'Профиль успешно обновлён!' : 'Профиль успешно создан и сохранён!'}
                  </h2>
                  <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                    {isEditMode
                      ? `Профиль «${createdProfile.name}» обновлён. Создана новая ревизия v${createdProfile.revision}. Ранее привязанные ловушки сохраняют свою текущую ревизию до планового обновления.`
                      : `Профиль «${createdProfile.name}» зарегистрирован в реестре C2. Конфигурации присвоена ревизия v${createdProfile.revision}.`}
                  </p>
                </div>

                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-left text-xs space-y-2">
                  <div className="flex justify-between">
                    <span className="text-slate-500">ID профиля:</span>
                    <span className="font-mono text-slate-800 font-semibold">{createdProfile.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Новая ревизия:</span>
                    <span className="font-bold text-brand-700">rev {createdProfile.revision}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Сервисов в профиле:</span>
                    <span className="font-medium text-slate-800">{createdProfile.services?.length || 0}</span>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
                  {onDeployInstance && (
                    <Button
                      variant="primary"
                      size="md"
                      leftIcon={<Rocket className="w-4 h-4" />}
                      onClick={() => {
                        onClose();
                        onDeployInstance(createdProfile, createdProfile.revision);
                      }}
                    >
                      Создать экземпляр ловушки (v{createdProfile.revision})
                    </Button>
                  )}
                  <Button variant="outline" size="md" onClick={onClose}>
                    Вернуться к каталогу
                  </Button>
                </div>
              </div>
            ) : (
              /* Wizard Step View */
              <div>
                {currentStep === 1 && (
                  <Step1TemplateLevel
                    name={name}
                    setName={setName}
                    description={description}
                    setDescription={setDescription}
                    templateId={templateId}
                    setTemplateId={setTemplateId}
                    errors={errors}
                  />
                )}

                {currentStep === 2 && (
                  <Step2ServicesPorts
                    services={services}
                    setServices={setServices}
                    errors={errors}
                  />
                )}

                {currentStep === 3 && (
                  <Step3BehaviorData
                    level={level}
                    visibleTexts={visibleTexts}
                    setVisibleTexts={setVisibleTexts}
                    credentials={credentials}
                    setCredentials={setCredentials}
                    fakeFs={fakeFs}
                    setFakeFs={setFakeFs}
                    errors={errors}
                  />
                )}

                {currentStep === 4 && (
                  <Step4LoggingChannel
                    level={level}
                    categories={categories}
                    setCategories={setCategories}
                    channel={channel}
                    setChannel={setChannel}
                    errors={errors}
                  />
                )}

                {currentStep === 5 && (
                  <Step5ReviewPreview
                    name={name}
                    description={description}
                    config={currentConfig}
                    errors={errors}
                  />
                )}
              </div>
            )}
          </div>

          {/* Modal Footer Controls */}
          {!createdProfile && (
            <div className="px-6 py-4 bg-slate-50/80 border-t border-slate-200 flex items-center justify-between">
              <div>
                {currentStep > 1 && (
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<ChevronLeft className="w-3.5 h-3.5" />}
                    onClick={handleBack}
                    disabled={isSubmitting}
                  >
                    Назад
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-2.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onClose}
                  disabled={isSubmitting}
                >
                  Отмена
                </Button>

                {currentStep < 5 ? (
                  <Button
                    variant="primary"
                    size="sm"
                    rightIcon={<ChevronRight className="w-3.5 h-3.5" />}
                    onClick={handleNext}
                  >
                    Далее
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<Check className="w-3.5 h-3.5" />}
                    onClick={() => handleSave()}
                    isLoading={isSubmitting}
                  >
                    {isEditMode ? 'Сохранить новую ревизию' : 'Сохранить профиль'}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Revision Conflict Resolution Modal (HTTP 409) */}
      <ProfileConflictModal
        isOpen={conflictOpen}
        onClose={() => setConflictOpen(false)}
        profileName={name}
        baseRevision={currentBaseRevision}
        serverRevision={serverRevision}
        draftConfig={currentConfig}
        onApplyOverServer={handleApplyOverServer}
        onAcceptServer={handleAcceptServer}
        onSaveAsCopy={handleSaveAsCopy}
        isSubmitting={isSubmitting}
      />
    </>
  );
};
