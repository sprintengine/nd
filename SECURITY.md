# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/sprintengine/nd/security/advisories/new). Do not open a public issue.

Include what you found, how to reproduce it and the impact you expect. We aim to acknowledge reports within three working days and to agree a disclosure date with you once a fix is ready.

## Scope

In scope: the code in this repository, including the API, the OCPP gateway and their handling of charger credentials, payments and personal data.

Out of scope: third-party services the platform integrates with (report those to the vendor), and findings that need physical access to a host's charger.

## Supported versions

The project has no releases yet. Fixes land on `main`.

## Handling secrets

Never put credentials, tokens, charger secrets or personal data in issues, pull requests or test fixtures. If you think a secret has been committed, report it privately as above so it can be rotated.
