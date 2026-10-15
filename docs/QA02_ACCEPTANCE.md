# QA-02: Low/Medium, команды и надёжная доставка

QA-02 собирает независимую приёмку FR-C3, FR-C4 и FR-A1–A4. Набор проверяет
два уровня decoy, управление через agent/center, сохранение событий в очереди
и восстановление после отказов. PostgreSQL-проверки создают отдельную схему
через `setupIntegration`; тестовые файлы и порты живут в `t.TempDir`.

Полный прогон с длительным сценарием разрыва запускается так:

```powershell
$env:TEST_DATABASE_URL = 'postgres://<test-user>:<test-password>@127.0.0.1:5432/<test-database>?sslmode=disable'
./scripts/test-qa02.ps1
```

Без `TEST_DATABASE_URL` Go пометит PostgreSQL-сценарии как skipped. Такой
прогон не является приёмкой QA-02.

## Матрица доказательств

| Область | Автоматические проверки |
| --- | --- |
| Low и Medium | `TestLowPageAndStop`, `TestMediumAuthFakeFSConsoleAndSessionIsolation`, `TestArchivePagesUseServerSessionsAndAppliedContent`, `TestTwoDecoyProcessesAcceptance` |
| Сессии, fake-FS, выход и истечение | `TestSuccessfulLoginUsesOneSessionIDAcrossEvents`, `TestExpiredSessionEndMustPersistBeforeRemoval`, проверки traversal/console в `internal/decoy` |
| Две ловушки и applied revision | `TestBE03DecoyTelemetryKeepsActuallyAppliedProfile`, `TestBE03AgentEventsMaintainVisitorSessions` |
| Команды start/stop/apply, TTL и плохая конфигурация | `TestBE02IsolationCommandsTelemetryAndTransactionalFailure`, `TestCommandResultSurvivesLostACKAndRestart`, `TestExpiredAndInterruptedCommandsNeverExecute`, `TestExecuteCommandPropagatesAdapterFailure` |
| Очередь, quarantine, переполнение и диск | `TestQueueUsesPrivateFilesAndFullDurability`, `TestDiskFullDoesNotACKOrLoseExistingEvents`, `TestFlushQuarantinesOnlyPermanentlyRejectedEvent`, `TestFlushRetriesAuthorizationErrorsWithoutQuarantine` |
| Потеря management-связи, рестарт агента и ACK после commit | `TestQA02EventDeliveryRetainsIDsAcrossOutageAndLostACK`, `TestBE02SixtySecondOutageRestartAndLostCommitACK`, `TestAgentProcessCrashRetainsAcknowledgedIPCEvents` |
| Фильтры, cursor и timeline | `TestControlPostgresFoundation`, `TestBE03AgentEventsMaintainVisitorSessions`, `events_test.go` |
| Одновременная телеметрия и heartbeat | `TestHeartbeatAndIntakeContinueDuringStalledDelivery`, `TestBE02IsolationCommandsTelemetryAndTransactionalFailure` |

`TestQA02EventDeliveryRetainsIDsAcrossOutageAndLostACK` использует настоящий
TLS-клиент, PostgreSQL handler и SQLite queue: сначала центр недоступен, затем
агент перезапускается, после чего отдельно моделируется потеря ответа после
commit. Проверяется множество `event_id`, глубина очереди и отсутствие дублей
в центре.

## Границы и честные условия

- 60-секундный тест проверяет management outage и lost commit ACK на локальном
  стенде; он не заменяет QA-03 проверки сетевой изоляции и firewall.
- Стартовый ориентир нагрузки из задания — 50 HTTP-действий/секунду в течение
  минуты и p95 до 3 секунд. Этот набор сохраняет функциональную приёмку; фактические
  latency/throughput фиксируются отдельным отчётом запуска и не выдаются за
  результат без измерения.
- Полный диск не обещает бесконечную сохранность: проверяется явный degraded/
  отказ записи, отсутствие ACK и сохранение уже записанных событий.
- Все cleanup-операции ограничены временными каталогами и изолированной схемой;
  пользовательский стенд и рабочая база не используются.
