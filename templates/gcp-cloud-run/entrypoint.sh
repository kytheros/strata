#!/bin/sh
set -e
litestream restore -if-replica-exists -o /tmp/strata/strata.db /tmp/strata/strata.db
litestream replicate &
exec node dist/cli.js serve --port 8080
