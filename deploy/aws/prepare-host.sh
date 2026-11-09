#!/usr/bin/env bash
# Run as root from a reviewed checkout; does not install software or activate TLS.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root' >&2; exit 1; }
for executable in docker nginx flock; do command -v "$executable" >/dev/null; done
docker compose version
deploy_user=${1:?Usage: prepare-host.sh EXISTING_DEPLOY_USER}
id "$deploy_user" >/dev/null
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -d -m 755 /srv/gizu /srv/gizu/incoming /srv/gizu/releases /srv/gizu/state
chown "$deploy_user:" /srv/gizu /srv/gizu/incoming /srv/gizu/releases /srv/gizu/state
install -d -m 750 -o root -g "$(id -gn "$deploy_user")" /etc/gizu
install -o root -g root -m 755 "$source_dir/deploy.sh" /usr/local/bin/gizu-deploy
install -o root -g root -m 644 "$source_dir/compose.yml" /etc/gizu/compose.yml
install -d -m 755 /var/www/acme
echo 'Host layout prepared. Secrets, registry login, TLS, NGINX activation and cutover gate still require operator setup.'
