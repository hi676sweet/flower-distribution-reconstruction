# Source context and historical dates

This file preserves the requested historical context without changing Git timestamps or presenting reconstructed work as original employer work.

| Item | Date / status |
| --- | --- |
| Resume-reported employer | 株式会社CAVIN |
| Resume-reported work period | **April 2026–August 2026** |
| Resume-reported domain | Flower distribution platform, producer/delivery management screens, frontend/backend API integration |
| This independent reconstruction | **Created November 2026**, with actual new-file and Git history |
| Personal contribution to the original product | Not independently established by this repository |

## Public context

- [CAVIN engineering role, published by the employer on Offers](https://offers.jp/jobs/94321): describes a flower marketplace connecting growers and florists, including producer/driver management screens, TypeScript/Next.js/NestJS, GraphQL, and data access. This identifies a product domain; a job description does not establish who implemented specific features.
- [Company-authored report hosted by JETRO](https://www.jetro.go.jp/ext_images/services/businessmodel/pdf/r7-01.pdf), dated March 26, 2026: describes CAVIN transaction/logistics systems and an export-platform project. That report predates the resume-reported April start. This repository does not claim the resume subject built the export platform.

Stocklane uses a deliberately smaller REST-based demonstration architecture. It independently models procurement receipts, inventory holds, florist orders, and dispatch. It does not replicate proprietary screens, schemas, infrastructure, code, business data, or original production history. Brand names, synthetic records, UI, and implementation in this repository were created for this reconstruction.

## Why REST and SQLite here?

The context includes GraphQL/PostgreSQL, but a self-contained NestJS REST API and Node's built-in SQLite make this demonstration easy to inspect, run, and test without external services. The important reproduced concept is transactional inventory/order behavior, not equivalence to the original company's architecture.

## Primary implementation documentation

- [NestJS v11 documentation](https://docs.nestjs.com/v11/first-steps)
- [Node.js 24 SQLite documentation](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- [React documentation](https://react.dev/learn)
- [Vite guide](https://vite.dev/guide/)
