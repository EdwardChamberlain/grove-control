#!/bin/bash

./test_frontend.sh && ./test_backend.sh && ./test_docker.sh && ./test_security.sh --full
