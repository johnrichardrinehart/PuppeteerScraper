#!/bin/bash

# https://github.com/browserless/chrome/blob/master/start.sh

set -e

_kill_procs() {
  kill -TERM $browserless
  kill -TERM $scraper
}

cd /usr/src/app # browserless app dir
./start.sh &
browserless=$!

cd /usr/src/scraper
yarn run start &
scraper=$!

wait $browserless
wait $scraper