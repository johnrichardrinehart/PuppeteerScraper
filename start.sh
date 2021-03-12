#!/bin/bash

# https://github.com/browserless/chrome/blob/master/start.sh

set +e # don't exit on non-zero code

_kill_procs() {
  kill -TERM $browserless
  kill -TERM $scraper
}

# Relay quit commands to processes
trap _kill_procs SIGTERM SIGINT

cd /usr/src/app # browserless app dir
./start.sh &
browserless=$!
printf "browserless running on PID $browserless\n"

cd /usr/src/scraper
dumb-init -- yarn run start &
scraper=$!
printf "scraper running on PID $scraper\n"

wait