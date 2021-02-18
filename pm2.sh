#!/bin/bash

# run like:
# > ./pm2.sh index_try_catch.js
# or
# > ./pm2.sh index_promise.js
#
# to console.log the memory usage use
# > ./pm2.sh index_promise.js track-memory

# track memory
if [[ $# -ge 2 ]]
then
	yarn dlx pm2 --wait-ready start "node --trace-warnings $1 track-memory" &
else
	yarn dlx pm2 --wait-ready start "node --trace-warnings $1" &
fi

# see which processes are running with:
# > yarn pm2 ls
# see the log of process 0 with:
# > yarn pm2 logs 0
# see the monitor (super cool) with:
# > yarn pm2 monit
