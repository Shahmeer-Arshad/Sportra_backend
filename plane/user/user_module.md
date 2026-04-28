# 📂 User Module Architectural Blueprint

This document outlines the operational chain of the User Authentication domain.

## 🧱 The Data Model (`User`)
Defined in `schema.prisma`. 
*   `id` (CUID)
*   `email` (Unique)
*   `username` (Unique)
*   `password` (Bcrypt hash)
*   `firstName`, `middleName`, `lastName`
*   `phone`, `profileUrl`
*   `role` (`USER` | `ADMIN`)

---

## 🌊 Execution Chain (Functional Flow)

Execution maps from API entry requests downwards through isolated functional scopes. 

### 1. Route Map (`user.routes.ts`)
Creates API handlers by wiring sub-actions securely via Dependency Injection closures.

### 2. Controller Gateway (`user.controller.ts`)
Converts raw HTTP parameters (`request.body`, `request.query`) into modular payload objects.

### 3. Service Worker (`user.service.ts`)
Runs high-level application invariants (checking duplicate emails, salt encryption generation).

### 4. Repository Store (`user.repository.ts`)
Manages raw SQL/Prisma executions safely.
