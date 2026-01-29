# Spectra Node

Microservice application for remote network status reporting and management. This app is part of the Spectra PHD Project

Example `.env`:
```
NODE_API_BASE=https://spectra.pequla.com/api
NODE_API_KEY=OBTAIN_TOKEN_FROM_WEB_APPLICATION
DEVICE_CHECK_INTERVAL=300000
COMMAND_CHECK_INTERVAL=2000
TERMINAL_MAX_LINES=12
COMMAND_TIMEOUT_MS=8000
```

On newer linux distrubutions `arp` library isnt available.
In order to fix that you will have to install it:

```bash
sudo apt install net-tools
```
