# HoneyForge Operator Console

React/TypeScript UI. Парк ловушек FE2-01 работает с `/api/v1`: список и карточка,
выбор конкретной revision, создание/назначение, одноразовый enrollment,
ZIP deployment bundle, серверные WebSocket-уведомления, результаты последних
команд и ссылки на события. После подключения и переподключения WebSocket
парк и команды перечитываются через REST. Опрос каждые 5 секунд сохраняется
для offline по last_seen, истечения команд и при недоступном WebSocket.
Остальные FE/QA-задачи сохраняют свои отдельные критерии приёмки.

## Локальный запуск

Нужны Node.js 22+ и Go 1.26+ для центра. В центре задайте DATABASE_URL и
PUBLIC_ORIGIN=http://127.0.0.1:5173, COOKIE_SECURE=false (только loopback),
LISTEN_ADDR=127.0.0.1:8081. Создайте оператора штатной командой
`go run ./cmd/control -create-user`; стандартной учётной записи у сервера нет.

```sh
cd web
npm ci
npm run dev
```

Откройте http://127.0.0.1:5173. Vite проксирует `/api` в центр и сохраняет Origin,
поэтому PUBLIC_ORIGIN должен совпадать с адресом браузера. Cookie/CSRF берутся
из настоящей серверной сессии. Продакшен-сборка: `npm run build`; для размещения
нужен единый TLS origin UI/API и корректный PUBLIC_ORIGIN. Сборка не публикует сайт.
`web/nginx.conf` — пример маршрутизации; защищённое размещение см. BE-04.

По умолчанию используется настоящий API. Фикстуры включаются явно и только
в dev-сборке; ошибки API не заменяются демоданными. Enrollment-токены находятся
только в памяти компонента, очищаются по истечении TTL/закрытии страницы и не
сохраняются в URL, localStorage или sessionStorage. Скачанный архив содержит
синтетические credentials профиля и доступен только оператору.

## Приёмка FE2-01

Нужны Go в PATH, Python 3, openssl, свободные loopback-порты 8081/5173 и отдельная
одноразовая PostgreSQL. Тест добавляет тестовые аккаунты/профили/ловушки в БД;
не используйте рабочую базу. Runtime-процессы и временные файлы очищаются автоматически.

```sh
npx playwright install chromium
export TEST_DATABASE_URL='postgres://postgres:<test-password>@127.0.0.1:55432/honeyforge_test?sslmode=disable'
npm run test:e2e
npm run build
npm run lint
```

Тест сам собирает и запускает настоящий Control API, TLS agent endpoint, Vite,
два бинарных агента и два decoy. Через браузер создаёт Low, Medium и второй
экземпляр Low-профиля, скачивает ZIP и запускает процессы из его конфигурации.
Проверяет apply_profile, реальные действия Medium и доставку событий в БД,
stopped при живом агенте, offline после остановки агента, reload и права viewer.
Отдельный сценарий инъецирует временную ошибку назначения/скачивания и короткий
TTL: повтор не создаёт дубликат, ошибки видны, токен удаляется из UI.

Это проверка локальных процессов из bundle-конфигурации. `install.sh`/Docker
Compose на отдельном подготовленном хосте и firewall остаются BE-04/QA-03.
Без TEST_DATABASE_URL сквозные тесты из trap-park.spec.mjs явно пропускаются.
trap-realtime.spec.mjs запускается без PostgreSQL: управляемые ответы API и WS
проверяют уведомления, reconnect с восстановлением через REST, ошибки команд,
резервный опрос и вывод недоверенного текста без HTML. Это проверка клиента,
а не доказательство запуска реального агента или сетевой изоляции.

## Узел и история регистрации

Мастер сохраняет `deployment_node` в реестре; список, карточка и manifest ZIP
показывают тот же узел после перезагрузки. Это заданное оператором имя узла,
а не доказательство автоматического удалённого запуска. Старые записи имеют
пустое имя; API принимает до 253 байт UTF-8 без управляющих символов.

`registration_status` (`pending`/`rejected`/`registered`) отделён от heartbeat
и состояния службы. API возвращает `agent_id` и последнюю попытку. Карточка
читает `/api/v1/traps/{id}/registration-attempts`: последние 100 попыток с
датой, результатом и причиной, cursor-пагинация, без токенов/хешей/тела запроса.
Неверный, истёкший, использованный/отозванный токен и уже имеющийся агент
различаются в истории. Публичный enrollment не раскрывает подробности токена.
Неизвестные trap_id и ошибки сети/TLS до достижения центра в неё не попадают.
Успешная регистрация и уже живой агент не превращаются в offline из-за чужой
неудачной повторной попытки.

## Настоящий bundle через установщик

На Linux с Docker, Go 1.26+, Node.js 22+, Python 3 и openssl, после `npm ci` и
`npx playwright install chromium`, с отдельной тестовой PostgreSQL:

```sh
export TEST_DATABASE_URL='postgres://postgres:<test-password>@127.0.0.1:55432/honeyforge_test?sslmode=disable'
./scripts/test-fe2-bundle.sh
```

Скрипт создаёт отдельный временный Linux-узел с собственным Docker Engine
(Docker-in-Docker), запускает браузерный сценарий и удаляет узел/его volumes.
Центр с PostgreSQL и TLS работает вне этого узла. Сценарий скачивает настоящий
ZIP, вызывает его `install.sh`, который клонирует зафиксированный commit,
собирает образы и запускает agent/decoy через Docker Compose. Затем UI/API
подтверждают agent_id, профиль/revision, действия Medium, доставку событий,
stop при живом агенте и offline после его остановки. Это контейнерный Linux-
стенд; проверка firewall конкретного production-хоста остаётся QA-03.

Для уже подготовленного отдельного тестового контейнера с Docker Engine можно
задать `HF_BUNDLE_DOCKER_NODE=<имя>` при `npm run test:e2e`. Требуются доступ к
HTTPS/GitHub/Go proxy/registry, доверие build-прокси и доступ агента к TLS центра.
Порт 8081/5173 должен быть свободен. Тестовый центр слушает agent TLS на адресе
Docker bridge gateway; тест создаёт доверенный временный CA и передаёт его
установщику. Проверка сертификата не отключается.

На обычном подготовленном узле распакуйте архив и выполните:

```sh
./install.sh --ca-file /absolute/path/to/trusted-center-ca.pem
# Для автоматизации вместо интерактивного ввода:
./install.sh --ca-file /absolute/path/to/trusted-center-ca.pem \
  --enrollment-token-file /absolute/path/to/private-enrollment-file
```

Без `--ca-file` используется системный CA bundle узла. Если сборка проходит
через HTTPS proxy с частным CA, `--build-ca-file /absolute/path/to/combined-ca.pem`
передаёт его как временный BuildKit secret; в runtime-образ он не попадает.
Для последующего старта используйте `docker compose -f compose.yaml up -d`,
а не повторное enrollment. Секреты и состояние остаются в приватном каталоге
комплекта и volumes; `down -v` удаляет состояние.
