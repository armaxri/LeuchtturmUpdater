# Test-only TLS certificate

`localhost.crt` / `localhost.key` form a self-signed certificate for `localhost` and
`127.0.0.1`, valid for 100 years. The local HTTPS fixture servers in the tests and the sandbox
use it to exercise `strictSSL` and `ca`. **It protects nothing; never use it elsewhere.**

Regenerate with:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout localhost.key -out localhost.crt \
  -days 36500 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```
