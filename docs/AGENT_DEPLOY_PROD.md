# Развёртывание БОЕВОГО сервера ГСК «Родник» — инструкция для ИИ-агента

Документ написан для автономного ИИ-агента (Claude Code и т. п.), у которого есть shell-доступ к **чистому Debian 12/13** и (по необходимости) к GitLab проекта. Следуйте шагам по порядку. Каждый шаг имеет **проверку**: не переходите дальше, пока она не пройдена. Документ составлен по опыту развёртывания тестового сервера, поэтому в нём перечислены реальные грабли (раздел 10).

Человеческая версия и справка: [DEPLOY.md](DEPLOY.md). Описание системы: [SPEC.md](SPEC.md).

---

## 0. Правила безопасности (обязательны)

1. **Секреты не печатать и не логировать.** Не выводите в чат/журнал содержимое `/etc/gsk/api.env`, закрытые ключи, пароль администратора, токены Runner. Проверяйте наличие значений без вывода: `grep -c '^DATABASE_URL=' файл`, `${VAR:+задана}`.
2. **Пароль первого администратора** показывается `setup.sh` один раз. Не копируйте его в файлы репозитория, коммиты, тикеты. Передайте владельцу единственным сообщением и попросите сохранить в менеджере паролей.
3. **Не отключайте защиту ради «чтобы заработало»:** не выключайте `ufw`, `StrictHostKeyChecking`, 2FA, `Protect variable` у боевых переменных GitLab, не открывайте порты в мир, не ставьте `chmod 777`, не запускайте API от root.
4. **Необратимые и внешние действия — только с явным подтверждением владельца:** удаление данных/баз, `restore.sh`, `ufw reset`, смена `TOTP_ENC_KEY`/`JWT_ACCESS_SECRET` на работающей системе, нажатие боевого деплоя в GitLab, смена DNS, выпуск сертификатов.
5. **Не меняйте `TOTP_ENC_KEY` и пароль БД на живой системе.** Потеря `TOTP_ENC_KEY` ломает 2FA всех сотрудников.
6. **Боевые данные не смешивать с тестом:** отдельный сервер, отдельные ключи CI, отдельные переменные GitLab (область `production`), отдельная база.
7. Любое отклонение от инструкции фиксируйте в итоговом отчёте. Если проверка не проходит и причина неясна — **остановитесь и спросите**, не импровизируйте.
8. Выполняйте команды с `sudo` только там, где это указано. Для файлов с секретами права `640 root:gsk`.

---

## 1. Входные данные (запросите у владельца до начала)

| Параметр | Пример | Зачем |
|---|---|---|
| `SERVER` | `203.0.113.10` / внутренний IP | куда подключаться по SSH |
| SSH-доступ | пользователь с `sudo`, ключ | подготовка сервера |
| `APP_DOMAIN` | `rodnik.example.ru` | сайт жителей (PWA) |
| `ADMIN_DOMAIN` | `admin.rodnik.example.ru` | портал правления |
| `ADMIN_PHONE` | `9001112233` | логин первого администратора, 10 цифр |
| `ADMIN_EMAIL` | `chairman@example.ru` | почта администратора |
| Схема доступа | NPM на этой машине / на другой (`NPM_IP`) / без NPM | см. раздел 4 |
| GitLab | URL, доступ к проекту, права Maintainer | переменные CI, защита ветки |
| Runner | есть ли, executor `shell` или `docker` | раздел 6 |
| Сертификат | кто выпускает TLS | NPM / внутренний ЦС |
| SMTP (по желанию) | хост, порт, логин, пароль, адрес отправителя | чеки и письма |
| Firebase (по желанию) | JSON сервисного аккаунта | push на Android |

Если чего-то нет — это не блокер для установки: почта и Firebase настраиваются позже (разделы 9.x).

---

## 2. Требования к серверу

* Чистый Debian 12 или 13, root/`sudo`, выход в интернет (apt, npm, nodesource, apt.postgresql.org).
* Минимум 2 vCPU, 2 ГБ ОЗУ (сборка идёт на Runner, но `npm ci` на сервере и Prisma требуют памяти), 20 ГБ диска.
* Синхронизация времени (`timedatectl` → `System clock synchronized: yes`): **обязательна** (TOTP, журнал, JWT).
* Часовой пояс сервера не важен (приложение работает по UTC/МСК явно), но запишите его в отчёт.

Проверка:
```bash
cat /etc/os-release | head -3; nproc; free -m | head -2; df -h / | tail -1; timedatectl | grep -E 'synchronized|Time zone'
```

---

## 3. Подготовка (на машине агента/владельца)

### 3.1. Получить код
```bash
git clone <URL проекта> gsk-rodnik && cd gsk-rodnik && git checkout main
git log --oneline -1          # запишите коммит в отчёт
```
Боевой деплой идёт **только с ветки `main`**, прошедшей на тесте.

### 3.2. Ключ CI для боевого сервера (отдельный от тестового)
```bash
ssh-keygen -t ed25519 -f gsk-ci-prod -C "gitlab-ci-prod" -N ""
```
`gsk-ci-prod.pub` пойдёт на сервер (шаг 5), закрытый `gsk-ci-prod` — только в переменную GitLab (шаг 7), затем удалить с диска/убрать в менеджер паролей. Закрытый ключ не коммитить.

---

## 4. Решение по схеме доступа

| Схема | Параметры `setup.sh` | Примечание |
|---|---|---|
| **NPM на этой же машине** | без `--listen-addr` (127.0.0.1) | порты 8081/8082 слушают только localhost; в NPM Forward Host `127.0.0.1` |
| **NPM на другой машине** | `--listen-addr <внутр. IP> --npm-ip <IP NPM>` | порты пускаются в ufw только от IP NPM |
| **Без NPM (не рекомендуется для боя)** | `--listen-addr <IP> --npm-ip <подсеть>` и **TLS обязателен другим способом** | иначе PWA/push/камера/буфер обмена не работают, куки без `secure`. Для production нужен HTTPS |

Для боя: HTTPS обязателен. Рекомендуемая схема — NPM (TLS, HSTS) → локальный nginx → API. При ней `TRUST_PROXY_HOPS=2`. Если прокси-цепочка другая — подберите значение (число прокси перед API) и проверьте раздел 8.4.

Если порт 8082/8081 режется сетью, используйте `--app-port/--admin-port` (напр. 8080).

---

## 5. Настройка сервера: `setup.sh`

```bash
scp -r deploy/server <пользователь>@SERVER:/tmp/gsk-setup
ssh <пользователь>@SERVER
cd /tmp/gsk-setup
sudo bash setup.sh --env prod \
  --app-domain "$APP_DOMAIN" --admin-domain "$ADMIN_DOMAIN" \
  --admin-phone "$ADMIN_PHONE" --admin-email "$ADMIN_EMAIL" \
  --deploy-pubkey "$(cat /путь/к/gsk-ci-prod.pub)" \
  [--listen-addr <IP> --npm-ip <IP или CIDR>] [--app-port N --admin-port N] [--ssh-port N]
```

Скрипт идемпотентен (безопасно запускать повторно; существующий непустой `api.env` с `DATABASE_URL` не перезаписывается). Он: ставит Node.js 22, PostgreSQL 16 (PGDG), nginx, ufw, fail2ban, unattended-upgrades; создаёт пользователей `gsk` (сервис, без входа) и `gsk-deploy` (приём релизов по ключу); создаёт БД `gsk_prod` (из `template0`, UTF8, `C.UTF-8`); генерирует секреты (`JWT_ACCESS_SECRET`, `TOTP_ENC_KEY`, ключи VAPID, пароль БД, пароль админа) и пишет `/etc/gsk/api.env` (640 root:gsk); ставит systemd-юниты (`gsk-api`, `gsk-backup.timer`), правило sudo (деплой может только перезапускать API), nginx-сайты, ufw, fail2ban.

> **Если вы подключены по SSH на нестандартном порту** — обязательно передайте `--ssh-port`, иначе `ufw` отрежет вас от сервера.

В конце скрипт печатает **пароль администратора — один раз**. Сохраните его так, как требует правило 2.

**Проверки шага 5:**
```bash
# 1. сервисы и порты
systemctl is-enabled gsk-api gsk-backup.timer nginx postgresql fail2ban
sudo nginx -t
ss -ltnp | grep -E ':(8081|8082)\b'          # адреса и порты как задумано (127.0.0.1 или внутр. IP)
sudo ufw status verbose                      # default deny incoming; SSH разрешён; 8081/8082 — только от NPM (если не localhost)
# 2. файл окружения: существует, непустой, права верные, секреты заданы (значения не выводить!)
ls -l /etc/gsk/api.env                       # -rw-r----- root gsk
sudo grep -cE '^(DATABASE_URL|JWT_ACCESS_SECRET|TOTP_ENC_KEY|VAPID_PUBLIC_KEY|VAPID_PRIVATE_KEY)=.' /etc/gsk/api.env   # = 5
sudo -u gsk-deploy bash -c 'set -a; . /etc/gsk/api.env; echo "URL=${DATABASE_URL:+задана}"'
# 3. боевой режим push включён (НЕ dry-run)
sudo grep -E '^(NODE_ENV|PUSH_DRY_RUN|TRUST_PROXY_HOPS)=' /etc/gsk/api.env     # production, 0, 2 (для схемы NPM→nginx→API)
# 4. база в UTF8
sudo -u postgres psql -tAc "SELECT datname, pg_encoding_to_char(encoding) FROM pg_database WHERE datname='gsk_prod'"
```
Ожидается `NODE_ENV=production`, `PUSH_DRY_RUN=0`. Если `PUSH_DRY_RUN=1` на боевом — это ошибка: исправьте (`sudo sed -i 's/^PUSH_DRY_RUN=.*/PUSH_DRY_RUN=0/' /etc/gsk/api.env`) и не забудьте перезапустить API после первого деплоя.

---

## 6. GitLab: Runner, переменные, защита ветки

### 6.1. Runner
Нужен Runner, который (а) умеет собрать проект (Node 22, npm, git, tar, build-essential, openssh-client; для executor `shell` всё это должно стоять в системе, для `docker` — образы `node:22-bookworm`, `alpine:3.20`), (б) видит боевой сервер по SSH, (в) имеет выход в интернет. Один Runner можно использовать для теста и боя. Docker для приложения **не нужен** (только как executor Runner'а). Регистрация без Docker: см. приложение в [DEPLOY.md](DEPLOY.md).

### 6.2. Переменные CI/CD (Settings → CI/CD → Variables), область **`production`**
| Переменная | Тип | Значение | Флаги |
|---|---|---|---|
| `SSH_PRIVATE_KEY` | **File** | содержимое `gsk-ci-prod` (**в конце перевод строки**) | Protect variable ✔ |
| `SSH_KNOWN_HOSTS` | **File** | вывод `ssh-keyscan -t ed25519 -p 22 <DEPLOY_HOST>` (адрес в строке = `DEPLOY_HOST` буква в букву) | Protect variable ✔ |
| `DEPLOY_HOST` | Variable | адрес боевого сервера | Protect variable ✔ |
| `DEPLOY_PORT` | Variable | только если SSH не на 22 | Protect variable ✔ |

Тестовые переменные (область `test`) не трогать и не дублировать: боевой ключ не должен попадать в тест и наоборот.

### 6.3. Защита ветки `main`
Settings → Repository → Protected branches: `main` — push и merge только Maintainers, force push запрещён. Это условие, при котором защищённые переменные (`Protect variable`) доступны пайплайну.

**Проверка:** `ssh-keyscan` выполняйте именно с того хоста, откуда Runner будет подключаться, или убедитесь, что отпечаток совпадает.

---

## 7. Первый боевой деплой

Боевой деплой ручной. **Перед кнопкой получите подтверждение владельца** (правило 4).

1. Убедитесь, что тот же коммит `main` уже выкачан и проверен на тестовом сервере (раздел «Приёмка» в конце этого документа, п. A).
2. GitLab → CI/CD → Pipelines → пайплайн ветки `main` → задачи `build` и `package` зелёные → у `deploy_prod` нажать **Run**.
3. В журнале `deploy_prod` должны быть шаги: распаковка → `npm ci` → `prisma generate` → «резервная копия базы перед миграциями» → «миграции базы» → «переключение на новый релиз» → «API отвечает — релиз … выкачен».
   * На самом первом деплое сообщение «база пуста (таблиц нет) — копия не нужна» — **норма**.
   * Если «API не ответил» — деплой откатывается сам; смотрите `sudo journalctl -u gsk-api -n 100 --no-pager`.

**Проверка:**
```bash
readlink /opt/gsk/current
systemctl is-active gsk-api
curl -fsS http://127.0.0.1:3000/api/health        # {"status":"ok"}
```

### 7.1. Создать первого администратора
```bash
sudo -u gsk-deploy /opt/gsk/bin/seed.sh
```
Затем убрать пароль из файла окружения (он больше не нужен) и перезапустить API:
```bash
sudo sed -i '/^SEED_ADMIN_PASSWORD=/d' /etc/gsk/api.env
sudo systemctl restart gsk-api
curl -fsS http://127.0.0.1:3000/api/health
```

---

## 8. Внешний доступ и TLS

### 8.1. DNS
`APP_DOMAIN` и `ADMIN_DOMAIN` должны указывать на NPM (или сервер, если без NPM). Проверка: `getent hosts $APP_DOMAIN`.

### 8.2. Nginx Proxy Manager — два Proxy Host
| | Жители | Правление |
|---|---|---|
| Domain | `APP_DOMAIN` | `ADMIN_DOMAIN` |
| Scheme / Host / Port | `http` / адрес сервера (или `127.0.0.1`) / `8081` | `http` / то же / `8082` |
| Cache Assets | **выключить** | **выключить** |
| Block Common Exploits | вкл | вкл |
| SSL | сертификат, **Force SSL, HTTP/2, HSTS** | то же |
| Advanced | `client_max_body_size 20m;` | `client_max_body_size 130m; proxy_read_timeout 300s; proxy_send_timeout 300s;` |

Рекомендуется Access List (разрешённые IP правления) на проксихост портала; сайт жителей остаётся открытым.

### 8.3. Проверки снаружи
```bash
curl -sI https://$APP_DOMAIN/ | head -5                   # 200, есть content-security-policy, strict-transport-security
curl -fsS https://$APP_DOMAIN/api/health                  # {"status":"ok"}
curl -fsS https://$ADMIN_DOMAIN/api/health
curl -sI http://$APP_DOMAIN/ | head -3                    # редирект на https (301/308)
# внутренние порты не должны быть доступны из мира:
nc -zv -w3 <внешний IP сервера> 3000   # должен НЕ подключаться
nc -zv -w3 <внешний IP сервера> 8081   # из интернета — НЕ подключаться (только от NPM)
```

### 8.4. Реальный IP клиента
Выполните вход с неверным паролем с известного IP, затем в портале (журнал действий) событие `auth.login.fail` должно содержать **этот** IP, а не адрес NPM/127.0.0.1. Иначе поправьте `TRUST_PROXY_HOPS` в `api.env` (число прокси перед API) и перезапустите API.

---

## 9. Закрепление безопасности и эксплуатация

### 9.1. Первый вход и 2FA (вместе с владельцем)
Войти на `https://$ADMIN_DOMAIN` (телефон `ADMIN_PHONE`, пароль из шага 5) → принять согласие на обработку ПДн → **включить двухфакторную защиту** (аутентификатор, QR) → **сохранить резервные коды** в менеджере паролей. Без этого работа в портале невозможна (политика включена по умолчанию).

### 9.2. SSH
Убедитесь, что вход по ключу работает **в другой сессии**, затем:
```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sudo sshd -t && sudo systemctl reload ssh
```
Не закрывайте текущую сессию, пока не проверите новый вход.

### 9.3. Почта (SMTP) — когда понадобятся квитанции
Добавить в `/etc/gsk/api.env`: `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURE` (`1` для 465), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`; `sudo systemctl restart gsk-api`; в портале «Настройки → Квитанции и почта» отправить тестовое письмо. Пока `SMTP_HOST` пуст — письма пишутся в `storage/mail-outbox` и **не отправляются**.

### 9.4. Push на Android (FCM)
Положить JSON сервисного аккаунта вне репозитория (например `/etc/gsk/firebase.json`, `640 root:gsk`), прописать `FCM_SERVICE_ACCOUNT_FILE=/etc/gsk/firebase.json`, перезапустить API. Подробности: [ANDROID.md](ANDROID.md). Web Push работает сразу (ключи VAPID созданы).

### 9.5. Резервные копии
```bash
systemctl list-timers gsk-backup.timer
sudo -u gsk bash -c 'set -a; . /etc/gsk/api.env; /opt/gsk/bin/backup.sh'
ls -l /var/backups/gsk/db | tail -3; cat /var/backups/gsk/last-backup.txt
```
Копии лежат на том же сервере; **вынос на внешнее хранилище (PBS/другой хост) — обязательное условие боевой эксплуатации**: уточните у владельца, что `/var/backups/gsk`, `/var/lib/gsk`, `/etc/gsk` попадают в внешнее резервное копирование. Копию `/etc/gsk/api.env` владелец хранит в сейфе (содержит `TOTP_ENC_KEY`). Восстановление проверить на тестовом сервере (`restore.sh`, см. DEPLOY.md §7).

### 9.6. Мониторинг
Минимум — внешняя проверка `https://$APP_DOMAIN/api/health` (например, Uptime Kuma) с уведомлением владельцу.

### 9.7. Обновление скриптов сервера
Скрипты в `/opt/gsk/bin/` устанавливает **`setup.sh`**, а **деплой их не обновляет**. Если в релизе изменились файлы `deploy/server/bin/*` или `systemd/*`, на сервере нужно повторить `setup.sh` (безопасно) либо установить файл вручную: `sudo install -m 755 -o root -g root <файл> /opt/gsk/bin/`.

---

## 10. Известные грабли (из опыта тестового сервера)

| Симптом | Причина | Решение |
|---|---|---|
| `createdb: new encoding (UTF8) is incompatible … SQL_ASCII` | кластер PostgreSQL создан в SQL_ASCII | исправлено в `setup.sh` (`--template template0`); использовать актуальный скрипт |
| `nginx: "server_tokens" directive is duplicate` | в Debian 13 `nginx.conf` уже содержит `server_tokens` | исправлено в `setup.sh`; актуальный скрипт |
| `api.env` пустой (0 байт), деплой: «DATABASE_URL не задана» | прерванный запуск `setup.sh` оставил пустой файл | актуальный `setup.sh` создаёт файл атомарно и пересоздаёт пустой; при ручной правке: удалить файл и запустить `setup.sh` заново |
| Деплой: «дамп пуст или повреждён» на первом деплое | пустая база, старая версия `backup.sh` на сервере | актуальный `backup.sh` (п. 9.7: скрипты не обновляются деплоем) |
| `chmod: cannot access ''` в CI | переменная `SSH_PRIVATE_KEY` не передана: неверная область (должна быть `production`), тип не **File**, или Protect variable при незащищённой ветке | проверить область, тип, защиту ветки `main` |
| `No ED25519 host key is known … strict checking` | в `SSH_KNOWN_HOSTS` нет ключа сервера | `ssh-keyscan -t ed25519 <DEPLOY_HOST>`, строка целиком, адрес совпадает с `DEPLOY_HOST` |
| Runner: `Cannot connect to the Docker daemon` | executor `docker` без Docker | поставить Docker либо перерегистрировать Runner как `shell` |
| `apk: command not found` в CI | shell-executor, образ не используется | актуальный `.gitlab-ci.yml` |
| Порт 8082 не открывается из сети, 8081 открывается | сетевой фильтр между клиентом и сервером | `--admin-port 8080` (или 80) |
| Сайт открывается, API 500 при пустых полях правки | баг слияния DTO | исправлен в коммите `f77f392` и новее |
| «Копировать» не работает | `http` не защищённый контекст | на боевом используется HTTPS; есть запасной способ |
| Задача пайплайна ветки `main` «запускается сама» | `build/package` идут на любой ветке; `deploy_prod` — только кнопкой | норма |

---

## 11. Откат

* Код: GitLab → пайплайн `main` → ручная задача **`rollback_prod`** (возвращает предыдущий выкаченный релиз; миграции базы **не** откатываются — они обратно-совместимы по дизайну).
* База: `sudo /opt/gsk/bin/restore.sh --db /var/backups/gsk/db/<дамп> [--files <снимок>]` — сначала без `--yes` (только план), затем с `--yes` **только с подтверждением владельца**. Перед восстановлением автоматически создаётся копия текущего состояния (`pre-restore`).
* Аварийный сброс 2FA пользователю: `sudo -u gsk-deploy /opt/gsk/bin/reset-2fa.sh 9001112233` (только по просьбе владельца).

---

## 12. Приёмка (чек-лист, все пункты — «да»)

**A. До деплоя на бой**
- [ ] Тот же коммит `main` выкачан на тестовый сервер, вход и основные сценарии проверены владельцем.
- [ ] `npm test -w @gsk/api` зелёный (в CI или локально).

**B. Сервер**
- [ ] `systemctl is-active gsk-api nginx postgresql fail2ban` → все `active`.
- [ ] `ufw status` — default deny incoming; наружу только SSH (и 8081/8082 только для NPM, если не localhost). Порт 3000 и 5432 извне недоступны.
- [ ] `/etc/gsk/api.env`: права `640 root:gsk`, `NODE_ENV=production`, `PUSH_DRY_RUN=0`, нет `SEED_ADMIN_PASSWORD`.
- [ ] БД в UTF8; миграции применены (`8+` в `_prisma_migrations`: `sudo -u postgres psql gsk_prod -tAc 'select count(*) from "_prisma_migrations"'`).
- [ ] `systemctl list-timers gsk-backup.timer` — активен; ручной `backup.sh` создал дамп.
- [ ] Время синхронизировано.

**C. Снаружи**
- [ ] HTTPS на обоих доменах, валидный сертификат, редирект с http, HSTS, CSP.
- [ ] `/api/health` отвечает по обоим доменам.
- [ ] В журнале действий IP клиента — реальный (п. 8.4).

**D. Доступ и аккаунты**
- [ ] Администратор вошёл, **2FA включена**, резервные коды сохранены владельцем.
- [ ] Вход жителя (создать тестового через портал → «Выдать пароль» → войти в PWA) работает; тестового жителя потом удалить.
- [ ] Неверный пароль 5 раз → учётная запись блокируется (проверять на **тестовом жителе**, не на администраторе).

**E. CI/CD**
- [ ] Боевые переменные GitLab защищены (`Protect variable`), ветка `main` защищена, закрытый ключ `gsk-ci-prod` удалён с рабочих машин.
- [ ] `rollback_prod` доступен.

**F. Передача владельцу**
- [ ] Передан (один раз, безопасным каналом): пароль администратора, список того, что нужно хранить в сейфе (`api.env`, резервные коды 2FA).
- [ ] Отчёт агента: коммит, версия релиза (`readlink /opt/gsk/current`), параметры `setup.sh`, отклонения от инструкции, нерешённые пункты (SMTP, FCM, внешний бэкап, мониторинг).

---

## 13. Чего агенту делать нельзя

* Печатать, коммитить или пересылать секреты и содержимое `api.env`.
* Выполнять боевой деплой, восстановление, смену ключей без подтверждения владельца.
* Отключать ufw/fail2ban/2FA/проверку ключа хоста; открывать порты 3000/5432 наружу.
* Запускать API или сборку от root; давать `gsk-deploy` лишние права sudo.
* Использовать тестовые ключи/переменные на бою и наоборот.
* Менять код приложения «по пути» без согласования: при найденной ошибке сообщите владельцу и предложите исправление отдельным коммитом.
