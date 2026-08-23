#!/bin/bash
set -e

mkdir -p /home/test/project /home/test/secret
echo "hello" > /home/test/project/hello.txt
echo "outside" > /home/test/secret/outside.txt
ln -sf /home/test/secret/outside.txt /home/test/project/escape
chown -R test:test /home/test
