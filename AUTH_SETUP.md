# Authentication Architecture: Guest to Authenticated User Flow

This repository utilizes a **Shadow Account (Lazy Registration)** pattern to handle guest users. 

This architecture allows users to interact with the application (e.g., adding items to a cart, setting preferences) before creating an account. Once they sign in using Google OAuth or an Email Magic Link, all their guest data is seamlessly merged into their new permanent account.

## System Flow

The system operates across three main phases:
1. **First Visit:** Generating a secure, `HttpOnly` guest session cookie.
2. **Anonymous Collection:** Linking user actions to the temporary guest ID.
3. **Login & Merge:** Converting the guest session into a permanent Better Auth session and migrating database records.

## Sequence Diagram

```mermaid
sequenceDiagram
    participant Browser as Browser (Client)
    participant NextJS as Next.js Frontend (SSR)
    participant Express as Express Backend
    participant DB as Database

    Note over Browser, DB: Phase 1: First Visit (No Cookies)
    Browser->>NextJS: 1. Visits website
    NextJS->>Express: 2. Request (No auth/guest cookie found)
    Express->>DB: 3. Create new Guest Session record
    DB-->>Express: 4. Returns guest_id (UUID)
    Express-->>NextJS: 5. Set-Cookie: guest_session_id (HttpOnly)
    NextJS-->>Browser: 6. Render page

    Note over Browser, DB: Phase 2: Anonymous Data Collection
    Browser->>NextJS: 7. User adds item / changes preference
    NextJS->>Express: 8. API Call (Browser auto-sends guest cookie)
    Express->>DB: 9. Save data linked to guest_id
    DB-->>Browser: 10. Success

    Note over Browser, DB: Phase 3: Login & Data Merge
    Browser->>NextJS: 11. User Signs In (Google/Magic Link)
    NextJS->>Express: 12. Auth Request (includes guest cookie)
    Express->>Express: 13. Better Auth generates user_id
    Express->>DB: 14. UPDATE data SET user_id = new_user, guest_id = NULL
    Express->>DB: 15. DELETE Guest Session record
    Express-->>Browser: 16. Set-Cookie: Auth Session, Clear Guest Cookie```
