#!/bin/sh
# win98.huatan.org certificate: Let s Encrypt via Cloudflare DNS (acme.sh), pushed into DSM for the reverse proxy.
#   sudo sh renew-cert.sh deploy   first time: push the current certificate into DSM
#   sudo sh renew-cert.sh          renew if due (and push again); DSM Task Scheduler runs this weekly as root
# The DSM push uses a temporary admin account that acme.sh creates and removes itself (no password stored).
R=/volume2/docker/ame-remote
# sudo / the task scheduler may leave the Synology tools (synouser...) off PATH
export PATH=/usr/syno/sbin:/usr/syno/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
set -a; . "$R/secrets/cloudflare.env"; set +a
export SYNO_USE_TEMP_ADMIN=1 SYNO_CERTIFICATE=win98.huatan.org SYNO_CREATE=1
A="sh $R/acme/acme.sh --home $R/acme --config-home $R/acme/data"
if [ "$1" = deploy ]; then
  $A --deploy -d win98.huatan.org --ecc --deploy-hook synology_dsm
else
  $A --cron
fi
