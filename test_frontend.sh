#!/bin/sh

cd frontend
npx tsc
npm run lint
npm run test:run
npm run setup:browser
npm run test:browser
cd ..
