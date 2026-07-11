#!/bin/sh

cd frontend
npx tsc
npm run lint
npm run test:run
npm run test:browser
cd ..
