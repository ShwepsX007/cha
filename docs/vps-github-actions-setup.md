# GitHub Actions для безопасного управления VPS

Схема использует **GitHub-hosted Actions по SSH**: постоянный GitHub Runner на production-сервер не устанавливается. Actions подключается отдельным непривилегированным пользователем `chata-deploy` и может выполнять только предусмотренные операции — `status`, `health`, `smoke` и ручной `deploy`.

Деплой не запускается автоматически при каждом push. Операции доступны только из `main` и защищаются GitHub Environment `production` с ручным подтверждением. Рабочая директория приложения — `/srv/chata`; текущий `/root/chata` остаётся нетронутым для отката.

> Репозиторий публичный, поэтому вывод Actions виден всем. Workflow намеренно не публикует сырые логи приложения и деплоя. Не помещайте в логи `.env`, содержимое чатов, пользовательские данные, токены или полные трассировки с конфигурацией.

## 1. Сначала включить workflows в `main`

Файлы workflow находятся в этой ветке. GitHub показывает `workflow_dispatch` только после попадания workflow-файла в default branch `main`. Сначала нужно открыть и слить PR этой ветки в `main`; пока этого не произошло, вручную запустить `VPS control` нельзя. Автоматический деплой на PR или push не настроен.

Workflow `CI` при этом проверяет PR и `main`: поднимает временный PostgreSQL, применяет миграции, запускает `npm run verify`, production build и read-only smoke test. Используются только тестовые данные, без production-секретов.

## 2. Подготовить VPS

Перед переносом сделайте резервную копию PostgreSQL и runtime-файлов приложения. Не удаляйте `/root/chata`, пока новый процесс не пройдёт health check и smoke test. Команды ниже рассчитаны на Debian/Ubuntu; если система другая, сначала адаптируйте создание пользователя и службы.

Создать пользователя без `sudo` и каталог приложения:

```bash
sudo useradd --system --user-group --create-home \
  --home-dir /home/chata-deploy --shell /bin/bash chata-deploy
sudo install -d -o chata-deploy -g chata-deploy -m 0750 /srv/chata
sudo install -d -o chata-deploy -g chata-deploy -m 0700 /home/chata-deploy/.ssh
```

Если пользователь уже существует, не создавайте его повторно; проверьте `id chata-deploy` и права на каталог.

### Проверить Node.js и PM2

`node`, `npm` и `pm2` должны находиться в `PATH` непривилегированного пользователя при **неинтерактивном SSH-вызове**. Например:

```bash
sudo -u chata-deploy -H bash -c \
  'command -v node && node --version && command -v npm && npm --version && command -v pm2 && pm2 --version'
```

Если Node установлен только через NVM пользователя `root`, это не подходит для workflow. Установите поддерживаемый Node.js и PM2 так, чтобы они были доступны `chata-deploy` без `sudo`.

### Перенести только runtime-данные

Workflow доставит исходники из `main`, но не перезапишет `.env`, `.data`, `logs` и legacy-аватары в `public/avatars`. Скопируйте текущие production-настройки и пользовательские файлы:

```bash
sudo install -o chata-deploy -g chata-deploy -m 0600 \
  /root/chata/.env /srv/chata/.env
sudo install -d -o chata-deploy -g chata-deploy -m 0750 \
  /srv/chata/.data /srv/chata/public/avatars
if [ -d /root/chata/.data ]; then
  sudo rsync -a /root/chata/.data/ /srv/chata/.data/
fi
if [ -d /root/chata/public/avatars ]; then
  sudo rsync -a /root/chata/public/avatars/ /srv/chata/public/avatars/
fi
sudo chown -R chata-deploy:chata-deploy /srv/chata
sudo chmod 0600 /srv/chata/.env
```

Не выводите `.env` на экран и не отправляйте его в чат. База данных остаётся той же; отдельно сохраните её резервную копию.

### Создать отдельный SSH-ключ для Actions

Создайте ключ без passphrase от имени нового пользователя, добавьте его публичную часть в `authorized_keys` с ограничениями и перенесите **приватную** часть прямо в GitHub Environment Secret — не в чат:

```bash
sudo -u chata-deploy -H ssh-keygen -t ed25519 -N '' \
  -C github-actions-cha -f /home/chata-deploy/.ssh/github-actions
sudo -u chata-deploy sh -c \
  'printf "restrict " >> /home/chata-deploy/.ssh/authorized_keys; cat /home/chata-deploy/.ssh/github-actions.pub >> /home/chata-deploy/.ssh/authorized_keys'
sudo chown -R chata-deploy:chata-deploy /home/chata-deploy/.ssh
sudo chmod 0700 /home/chata-deploy/.ssh
sudo chmod 0600 /home/chata-deploy/.ssh/authorized_keys
```

В приватном SSH-сеансе на VPS покажите файл `/home/chata-deploy/.ssh/github-actions` и скопируйте его целиком в secret `DEPLOY_SSH_KEY` (включая строки `BEGIN`/`END`). После сохранения secret удалите приватный файл с VPS; публичный `.pub` и строку в `authorized_keys` оставьте. Если ключ генерируется на доверенном компьютере администратора, приватный файл не нужно переносить на VPS — на сервер добавляется только публичный ключ.

## 3. Создать защищённое окружение GitHub

В `Settings → Environments` создайте environment с именем **`production`**:

- разрешённая ветка деплоя — только `main`;
- добавьте себя в `Required reviewers`, чтобы каждый production-деплой/запрос к VPS требовал подтверждения.

В этом environment задайте **Variables**:

| Имя | Значение |
| --- | --- |
| `DEPLOY_HOST` | DNS-имя или IPv4 VPS |
| `DEPLOY_USER` | `chata-deploy` |
| `DEPLOY_PORT` | SSH-порт, обычно `22` |
| `APP_PORT` | порт Next.js, обычно `8010` |

И **Secrets**:

| Имя | Значение |
| --- | --- |
| `DEPLOY_SSH_KEY` | приватный ключ из предыдущего шага |
| `DEPLOY_KNOWN_HOSTS` | проверенная строка host key для VPS |

Для `DEPLOY_KNOWN_HOSTS` не доверяйте слепо результату `ssh-keyscan`: сверяйте fingerprint ED25519, полученный с консоли VPS (`/etc/ssh/ssh_host_ed25519_key.pub`), с fingerprint при сканировании с доверенного компьютера. Для нестандартного SSH-порта используйте `ssh-keyscan -p PORT -t ed25519 -H HOST`; сохраните его вывод как secret. Не вставляйте ключи или пароли в workflow-файл.

## 4. Первый запуск и переключение

1. Убедитесь, что `.env`, Node.js, npm, PM2 и пользовательские файлы готовы в `/srv/chata`.
2. Пока старый процесс всё ещё работает, в `Actions → VPS control` запустите `status` и проверьте подключение. `health`/`smoke` до первого деплоя могут не пройти, потому что приложение ещё не скопировано.
3. Остановите старый PM2-процесс `chata` **от имени того пользователя, который его запустил** (судя по прежнему размещению, возможно, `root`). Не удаляйте старый каталог.
4. Запустите `deploy` из `main` и подтвердите environment approval. Workflow синхронизирует исходники в `/srv/chata`, сохраняя runtime-данные, затем выполняет `npm run deploy` и read-only `npm run smoke`.
5. После успешного запуска настройте автозапуск PM2 для `chata-deploy` по инструкции `pm2 startup`, проверьте `pm2 save` и повторно запустите `status`.
6. Оставьте `/root/chata` и резервные копии до завершения проверки после перезапуска VPS.

У `deploy` есть плановые миграции БД и перезапуск приложения. Если первый переключатель не прошёл, не удаляйте старый каталог: ошибка деплоя сообщит путь к закрытому лог-файлу в домашнем каталоге `chata-deploy`; просматривать его следует по SSH, не публикуя содержимое в открытых Actions-логах.

## 5. Как запускать проверки

После слияния workflow в `main`:

- `Actions → VPS control → Run workflow → main`;
- `status` — PM2, Node/npm, место на диске и health JSON;
- `health` — секрето-безопасная проверка БД, схемы и статуса интеграций;
- `smoke` — read-only проверки HTTP/API;
- `deploy` — ручная доставка кода, миграции, build, перезапуск и smoke test.

Текущий health JSON показывает `push: false`, пока production VAPID-параметры не настроены. Сырые логи PM2 намеренно не доступны через публичный Actions-run; для их изучения используйте прямой SSH-доступ, а при необходимости публиковать больше диагностики сначала переведите репозиторий в private и всё равно не выводите пользовательское содержимое.
