# 🚀 Getting Started with Node Starter

Welcome to your production-ready Fastify v5 & Prisma Node.js boilerplate.

## 🛠️ Technology Stack
*   **Engine:** Node.js + Fastify v5 (The highest performance Node framework)
*   **Database:** PostgreSQL managed via Prisma ORM
*   **Validation:** Zod schemas
*   **Tests:** Vitest Runner

---

## 🏗️ Clean Architecture (Functional Pattern)

Your logic builds layers using **Dependency Injection** without complex framework magic:

$$\text{Routes} \longrightarrow \text{Controller} \longrightarrow \text{Mediator} \longrightarrow \text{Service} \longrightarrow \text{Repository}$$

*   **Repository:** Directly maps database read/writes.
*   **Service:** Holds pure validation checks and data logic.
*   **Mediator:** Prevents circular imports and separates handlers.
*   **Controller:** Extracts HTTP configurations.

---

## 🚦 Local Startup Instructions

### 1. Configure Secrets
Duplicate the template configuration:
```bash
cp .env.example .env
```

### 2. Boot Database UI 
Start your persistent backend services via Docker:
```bash
docker-compose up -d
```
*   **Database Adminer UI:** Access via [http://localhost:8080](http://localhost:8080).

### 3. Build Tables & Run
```bash
npm install
npx prisma migrate dev
npm run dev
```

### 4. Execute Automated Checks
```bash
# Run all tests
npm run test

# Run tests for a specific module only
npm run test tests/user.test.ts

# OR

npx vitest user

```
