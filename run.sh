#!/bin/bash

fetch_every()
while [ 1 ]
do
   sleep $1; # every <n>s
   curl -vvv http://localhost:8000/content\?url\=$2
done

for var in "$@"
do
    fetch_every 2 $var &
done

wait
