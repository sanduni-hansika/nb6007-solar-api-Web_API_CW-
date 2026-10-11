# SLSEA Solar Generation Data API

A RESTful API for managing rooftop solar installations and electricity generation data across Sri Lanka. Developed for **NB6007CEM – Web API Development Coursework 1** using Node.js, Express.js, and PostgreSQL hosted on Neon.

## Features

- Manage provinces, districts, grid substations, and solar installations.
- Store and retrieve historical generation readings.
- Access installation readings and district generation summaries.
- Authenticate users and enforce role-based, geographical access controls.
- Restrict metering devices to submitting readings for their assigned installations.
- Validate requests and return appropriate HTTP status codes.
- Interactive Swagger documentation and health monitoring.

## Technology Stack

Node.js · Express.js · PostgreSQL · Neon · JWT · Swagger/OpenAPI · Git/GitHub

## Getting Started

**Requirements:** Node.js, npm, and a Neon PostgreSQL database.

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and configure the required environment variables.
3. Start the development server: `npm run dev`
4. Use the configured seed scripts to initialise demonstration data if needed.

## Seed Data

The seed process generates:

- 9 provinces, 25 districts, 50 grid substations, and 250 installations.
- 7 days of readings at 15-minute intervals: 96 readings per installation per day, producing approximately **168,000 readings**.
- Realistic daily generation curves, regional weather variation, and a cumulative energy register.

## Demo Accounts and Permissions

All demo user passwords are configured through `SEED_PASSWORD`.

| Role | Example login | Access |
|---|---|---|
| Admin | `admin@slsea.example` | National read access; manage substations, installations, and users; retract readings |
| National | `national@slsea.example` | Read all data |
| Provincial | `provincial.western@slsea.example` | Read own province only |
| District | `district.colombo@slsea.example` | Read own district only |
| Device | `SLSEA-MTR-0001` | Submit readings for its assigned installation only |

Provincial and district accounts are also seeded for the other relevant areas. Retrieve a device secret using `npm run device-secret -- SLSEA-MTR-0001`; keep it private.

## System Architecture

Clients (users and metering devices) → Express.js REST API → Authentication and authorisation middleware → Request validation and route handlers → Neon-hosted PostgreSQL database.

## Live API

- **Base URL:** `https://nb6007-solar-api-web-api-cw.onrender.com`
- **Swagger Documentation:** ` https://nb6007-solar-api-web-api-cw.onrender.com/api-docs`
- **Health Check:** ` https://nb6007-solar-api-web-api-cw.onrender.com/health`
-

## Local API
- **Base URL:** `http://localhost:3000`
- - **Swagger UI:** `http://localhost:3000/api-docs`
- - **Health Check:** `http://localhost:3000/health`

## Testing

Test the API using Swagger UI and the automated test scripts configured in `package.json`. Verify authentication, jurisdiction restrictions, reading submission, invalid input, error responses, and database operations. Report only test results that have actually been run.

## Deployment

The API can be deployed to a Node.js hosting platform such as Render and connected to Neon PostgreSQL. Add the verified live API and Swagger URLs after deployment and test them.

## Environment Variables

Configure the variables required by `.env.example`, including:

- `DATABASE_URL` — Neon PostgreSQL connection string
- `DATABASE_SSL` — database SSL configuration
- `JWT_SECRET` — token-signing secret
- `SEED_PASSWORD` — demo account password
- `PORT` and `NODE_ENV` — server configuration


**Index Number:** COBSCCOMP251P-067
