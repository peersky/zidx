# License

Copyright (c) 2026 Tims Pecerskis <t@peersky.xyz>

## Purpose of this submission

This repository was produced as an unpaid take-home assessment for the
**Zama Protocol** engineering interview. It is shared for the sole purpose
of evaluation by Zama and its agents acting on its behalf.

## Permitted use

For the purpose of evaluating this submission, the recipient (Zama and its
authorized reviewers) may:

- Read, run, test, and reproduce the code in this repository.
- Share it internally within their organization for the purpose of review
  and hiring decisions.
- Discuss the design, code, and architecture in interviews or feedback
  sessions related to this submission.

## Not granted

All other rights are reserved. In particular, **no rights are granted** to:

- Use any part of this code, design, or documentation in any commercial,
  production, or revenue-generating context.
- Incorporate any part of this work into any product, service, framework,
  library, or codebase distributed publicly or internally beyond the scope
  of evaluating this submission.
- Redistribute, sublicense, publish, or republish this work, in whole or
  in part, in any form, except as required for the evaluation described above.
- Train, fine-tune, or otherwise use this work as input to any machine
  learning model, dataset, or AI system.

## Third-party components

This repository depends on third-party open-source software (see
`package.json`, `Dockerfile`, `contracts/foundry.toml`, and the `forge-fhevm`
submodule). Each such component is licensed under its own terms, unchanged
by this LICENSE. Notably:

- `@openzeppelin/confidential-contracts` — MIT
- `@zama-fhe/sdk` — see the package's own LICENSE
- `forge-fhevm` (vendored as git submodule) — BSD-3-Clause
- Envio HyperIndex — BSD-3-Clause
- NATS, Fastify, postgres.js, viem, etc. — see each project's LICENSE

## Contact

For any other use, please contact t@peersky.xyz.
