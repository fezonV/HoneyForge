# BE-03: рабочие Low и Medium

Приёмка 14 октября 2026 года. Runtime из PR #23 дополнен серверными страницами
на основе лаборатории #18: каталог Low, настоящий вход Medium, ошибка входа,
список/просмотр/скачивание файлов, псевдоконсоль, выход, истечение сессии,
пустой каталог, 404 и остановленный сервис. Исходники и правила обновления
описаны в [decoy-templates](../decoy-templates/README.md).

Результат строится из применённой revision, не из желаемой или fixture.
Сессия живёт 900 секунд, изолирована по экземпляру, сбрасывается после stop
и применения новой версии. HTML экранируется, CSP запрещает скрипты и внешние
ресурсы. JSON/raw-ответы API сохраняются для клиентов без Accept text/html.

| Критерий issue #3 | Подтверждение |
|---|---|
| Одновременные отдельные Low/Medium | `TestTwoDecoyProcessesAcceptance`: два настоящих бинарных процесса, разные listener/config/очереди, реальные HTTP и IPC |
| Medium требует вход, события связаны с сессией | Тесты Medium и `TestBE03AgentEventsMaintainVisitorSessions`, `TestBE03DecoyTelemetryKeepsActuallyAppliedProfile` |
| Изоляция экземпляров | Процессный тест, проверка чужой cookie, профиля и остановки только одного сервиса |
| Применение баннера/credentials | Процессный тест применяет revision 2 через adapter, отвергает старые credentials и проверяет сохранение после рестарта |
| Вход → файл → псевдокоманда | BE-03 PostgreSQL integration: decoy → HTTP IPC → SQLite → TLS API → PostgreSQL; фактические profile/revision и session_id |
| Traversal/OS-команды отклонены | Тесты fake-FS/Medium/console и `TestArchivePagesUseServerSessionsAndAppliedContent`; только pwd/ls/cat по структурам профиля |
| Секреты и внутренние адреса не выдаются | Тесты публичных ответов и HTML; экранирование title/content/output, отсутствие management-ресурсов |

Воспроизведение (Go 1.26+, отдельная PostgreSQL):

```sh
export TEST_DATABASE_URL='postgres://postgres:<test-password>@127.0.0.1:55432/honeyforge_test?sslmode=disable'
HF_DECOY_PROCESS_TEST=1 go test -count=1 -v ./cmd/decoy
go test -count=1 -v ./internal/control -run '^TestBE03'
go test -race -short -count=1 ./...
go vet ./...
go build ./...
```

Проверка развёртывания на отдельном физическом/удалённом узле и firewall
остаётся BE-04/QA-03. Здесь подтверждён реальный процессный запуск на локальном
стенде; это не заявление о сетевой изоляции внешнего deployment.
