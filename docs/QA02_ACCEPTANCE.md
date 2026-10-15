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

## Integration corrections

Run the complete Linux gate with `scripts/test-qa.sh` (no `-short`, real process
flag enabled). The short QA script includes the PostgreSQL foundation tests for
filters/cursors. Both outage tests compare exact locally acknowledged IDs with
PostgreSQL IDs. The 60-second outage drives 100 real HTTP requests through decoy and HTTP IPC,
simulates management HTTP 503, closes/reopens the SQLite queue at 30 seconds
and loses a post-commit response; it is not a physical network
partition or a PostgreSQL process restart. The agent crash test uses a real
process with a controlled TLS endpoint, while live Playwright uses actual
control/agents/decoys/PostgreSQL.

`TestQA02HTTPActionLoadToCommittedEvents` offers 3000 real HTTP actions at 50/s
for 60 seconds through decoy → HTTP IPC → SQLite → TLS → PostgreSQL and measures
committed-event observation latency. It compares local ACK IDs and stored IDs.
This metric is not UI rendering latency. The final dashboard latency still
depends on #12/#13. Compose independently checks combined filters/cursors over 125 IDs and a 132-ID
timeline before/after a real PostgreSQL/control restart on a persisted volume,
including historical revision 1 after creating profile revision 2.
