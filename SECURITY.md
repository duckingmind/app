# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Use the
repository's GitHub Security Advisories page when this project has been
published, or contact the maintainers privately with:

- a clear description of the affected component and impact;
- reproducible steps or a minimal proof of concept;
- the first known affected version and a suggested fix, if available.

Do not include access tokens, cookies, provider credentials, production logs,
or user data in a report. Remove or rotate credentials immediately if one is
accidentally exposed.

## Credential boundaries

The following values must remain outside Git, published app bundles, and issue
reports:

- `PROXY_USER_ACCESS_TOKEN` and legacy `PROXY_ACCESS_TOKEN`;
- Portal cookies, App Sessions, and `ast_*` tokens;
- provider/API keys, object-storage credentials, and `.env` files;
- `.proxy-app.json`, which contains the private platform application binding.

The SDK app runtime must use the platform App Session and must not read Portal
cookies or management tokens.
