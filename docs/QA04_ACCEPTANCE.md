# QA-04: CI, Playwright и воспроизводимая сдача

QA-04 связывает независимые проверки QA-01–03 с browser smoke и реальным
сквозным сценарием. Workflow [`.github/workflows/qa.yml`](../.github/workflows/qa.yml)
запускается на pull request и на `dev`, `main`, `QA-04`. Все обязательные jobs
завершаются ошибкой при нарушении проверки; ни один job не использует
`continue-on-error`.

## Jobs

| Job | Что подтверждает |
| --- | --- |
| `backend` | gofmt, race-тесты без долгих process сценариев, `go vet`, build, OpenAPI lint и Compose schema. PostgreSQL — disposable service. |
| `web` | TypeScript build, ESLint, Playwright mock/reconnect/security smoke и артефакты trace/screenshot/report. |
| `live-e2e` | `trap-park.spec.mjs` с настоящими Control API, PostgreSQL, агентами и Low/Medium decoy. Проверяются профили, два экземпляра, bundle, команды, applied revision и события. |
| `compose-health` | Чистый `docker compose up --build`, миграции и `/readyz`; cleanup выполняется через `trap`. |

Локальный запуск полного набора требует Go 1.26+, Node.js 22+, Docker,
PostgreSQL и Chromium:

```sh
cp .env.example .env
# установите в .env отдельный POSTGRES_PASSWORD
export TEST_DATABASE_URL='postgres://honeyforge:<password>@127.0.0.1:5432/honeyforge_test?sslmode=disable'
go test -race -short -count=1 ./...
go vet ./...
go build ./...
npx --yes @redocly/cli@latest lint api/openapi.yaml
npm --prefix web ci
npm --prefix web run build
npm --prefix web run lint
npx --prefix web playwright install chromium
npm --prefix web run test:e2e -- e2e/trap-realtime.spec.mjs e2e/trap-control.spec.mjs e2e/profile-preview.spec.mjs --reporter=line
npm --prefix web run test:e2e -- e2e/trap-park.spec.mjs --reporter=line
```

В PowerShell тот же backend/schema/web набор можно запустить через
`./scripts/test-qa04.ps1` после настройки `TEST_DATABASE_URL`.

`trap-park.spec.mjs` создаёт синтетических пользователей и ресурсы в отдельной
схеме, собирает временные бинарники и удаляет процессы/файлы в `afterAll`.
Для Docker bundle acceptance используйте отдельный подготовленный Linux host:

```sh
HF_BUNDLE_DOCKER_NODE=<prepared-docker-container> ./scripts/test-fe2-bundle.sh
```

Это отдельный infrastructure gate: CI не выдаёт локальный runner за проверку
firewall production-хоста.

## Трассировка обязательного smoke

- Вход оператора → создание Low/Medium профилей → два экземпляра одного
  профиля.
- Enrollment и ZIP bundle → запуск агента/decoy → реальные HTTP-действия.
- Medium login/file/console/session → события PostgreSQL и timeline.
- Изменение revision и применение только к экземпляру A; экземпляр B сохраняет
  старую applied revision и поведение.
- Start/stop, TTL/error command, reconnect WebSocket и восстановление через REST.
- Viewer, конфликт revision, session expiry, XSS-safe text rendering и отсутствие
  credentials в browser storage/preview.

## Артефакты и ограничения

CI сохраняет `web/test-results` и `web/playwright-report` даже при падении
browser job. Итоговый отчёт должен содержать commit SHA, ОС, версии Go/Node/
Chromium/Docker/PostgreSQL, команды, длительность, p95 только при измерении,
ссылки на артефакты и известные ограничения. Синтетические seed-данные нельзя
описывать как внешние атаки.

QA-04 не закрывает бонусы FR-C6/FR-C7/FR-A5/FR-A6/MASK-5–7. Remote bundle,
firewall и сетевые сегменты требуют собственного стенда; workflow фиксирует это
как отдельную границу, а не как молча выполненное условие.
