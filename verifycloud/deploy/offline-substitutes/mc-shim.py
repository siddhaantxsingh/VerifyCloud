#!/usr/bin/env python3
# answers `mc ready local` (the compose health check) for the moto stand-in
import sys, urllib.request
try:
    urllib.request.urlopen("http://127.0.0.1:9000/", timeout=2)
    sys.exit(0)
except Exception as e:
    if getattr(e, "code", None):  # any HTTP answer means the server is up
        sys.exit(0)
    sys.exit(1)
