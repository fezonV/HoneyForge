# FE2-01: парк, регистрация и настоящий bundle

Приёмка 14 октября 2026 года. Дополнение к PR #24 и #27: узел запуска,
история регистрации и запуск скачанного ZIP его установщиком. Проверенный
runtime source commit: `81465b9` (финальные последующие изменения — документация).

## Стенд и воспроизведение

Отдельная одноразовая PostgreSQL 17; настоящий Control API; TLS endpoint с
временным доверенным CA; Vite и Chromium/Playwright. Подготовленный Linux-узел —
привилегированный контейнер `docker:28-dind` с собственным Docker Engine 28.5.2
и хранилищем vfs. Он не получает Docker socket родителя. Финальный прогон создаёт
новый узел с пустым Docker Engine: образы и Go-зависимости собираются с нуля.

```sh
export TEST_DATABASE_URL='postgres://postgres:<test-password>@127.0.0.1:55432/honeyforge_test?sslmode=disable'
./scripts/test-fe2-bundle.sh
```

Предварительные зависимости и вариант с уже подготовленным узлом описаны в
[web/README.md](../web/README.md). Нужен доступ к HTTPS registry/GitHub/Go proxy.
При частном CA build-прокси он передаётся временным BuildKit secret, а CA центра —
отдельным runtime secret. Проверка TLS не отключается. Токен выдаётся отдельно,
не входит в ZIP, URL, аргументы процесса или browser storage.

## Подтверждённое поведение

| Требование | Проверка |
|---|---|
| Создание Low/Medium и второго Low из одного профиля | Настоящие UI/API и PostgreSQL; разные trap_id, сохранённый deployment_node |
| Узел после reload и в комплекте | Поле PostgreSQL/API, список/карточка, manifest; unit/integration и browser-проверки |
| Отказ регистрации отдельно от offline/stopped | Реальный неверный enrollment → 401, история с причиной в UI после reload; после успешной регистрации остаётся зарегистрированный агент |
| История без секретов | PostgreSQL integration: неверный/истёкший/неактивный токен, успех, повторная регистрация, последние 100 попыток, пагинация, отсутствие токенов/хешей, 401/403 |
| Настоящий bundle | Через UI скачиваются ZIP Low и Medium; их install.sh клонирует pinned commit, собирает образы и запускает Compose на отдельном узле |
| Фактическая конфигурация | Агент регистрируется по TLS, apply_profile подтверждается decoy через IPC, applied revision = 1; Medium показывает содержимое выбранного профиля |
| Действия и события Medium | Вход → просмотр файла → псевдокоманда → выход; command.received доставлен через agent в PostgreSQL |
| Источник события | TCP-шлюз передаёт исходные IP/порт через PROXY v1 на приватный listener; Docker E2E проверяет source_ip, unit-тесты — адрес, payload и отклонение неверных заголовков |
| Изоляция и независимость | Decoy только во внутренних сетях, исходящее TCP-подключение decoy к доступному TLS центра не проходит; после stop Medium Low продолжает отвечать |
| Раздельные состояния | Stop Medium оставляет агент online и service stopped; после остановки агента серверный last_seen приводит к offline; состояние сохраняется после reload |
| Viewer и обработка ошибок | Отдельные browser-сценарии: нет создания/токена/bundle, прямые API 403; повтор назначения без дубля, ошибка ZIP, истечение токена |
| WebSocket за reverse proxy | PR #27: регрессия handshake с configured public Origin; browser получает Live WS, проверяются обновления/reconnect/fallback |

Для публикации visitor-портов используется отдельный минимальный TCP-шлюз с
фиксированной целью decoy и списком портов. У него нет management-сети,
IPC-секретов и конфигурационного volume decoy. Это исправляет поведение Docker,
который не публиковал порты сервиса из одних только internal-сетей. Decoy принимает
PROXY v1 только при явном флаге в bundle; обычный бинарный запуск остаётся прямым.

## Проверки и границы

- `HF_DECOY_PROCESS_TEST=1 go test -short -race ./...` с PostgreSQL;
- `go vet ./...`, `go build ./...`, проверка OpenAPI;
- `npm --prefix web run build`, `npm --prefix web run lint`: 0 ошибок,
  32 существовавших предупреждения;
- пять стандартных Playwright-сценариев и отдельный настоящий Docker bundle E2E.

Это приёмка настоящего установщика на отдельном контейнерном Linux-узле,
с реальными Docker, PostgreSQL, TLS, агентами и decoy. Физическая/удалённая VM,
production firewall, нагрузочные характеристики, полный production Compose
центра с UI и оставшиеся требования BE-04/QA-03 требуют отдельной приёмки.
Issue #4 и #16 этим документом не закрываются.
