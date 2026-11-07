#!/bin/sh

set -e

cd frontend
npm run typecheck
npm run lint
npm run test:run
npm run setup:browser
npm run test:browser
cd ..
