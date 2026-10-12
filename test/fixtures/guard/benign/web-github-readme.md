# quickserve

[![CI](https://img.shields.io/github/actions/workflow/status/example/quickserve/ci.yml?branch=main&style=flat-square)](https://github.com/example/quickserve/actions)
[![npm](https://img.shields.io/npm/v/quickserve?color=blue&logo=npm)](https://www.npmjs.com/package/quickserve)

A zero-config static file server with live reload.

## Install

```sh
curl -fsSL https://get.quickserve.example.dev/install.sh | sh
# or
npm install -g quickserve
```

## Usage

```sh
quickserve ./public --port 8080 --open
```

Set `QUICKSERVE_TOKEN` in your environment to enable the admin API. Never commit your token; add `.env` to `.gitignore`.

## Options

| Flag | Default | Description |
|---|---|---|
| `--port` | 3000 | Port to listen on |
| `--open` | false | Open the browser |
| `--no-reload` | — | Disable live reload |
| `--spa` | false | Serve index.html for unknown routes |

## Contributing

Fork the repo, run `npm test`, and open a pull request. Please run the linter before you push.

## Security

Report vulnerabilities privately to security@quickserve.example.dev. Please don't open public issues for security reports.
